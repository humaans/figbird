import { EventEmitter } from 'node:events'
import { feathers, type Application } from '@feathersjs/feathers'
import { MemoryService } from '@feathersjs/memory'
import test from 'ava'
import {
  FeathersAdapter,
  type FeathersAdapterOptions,
  type FeathersClient,
  type FeathersService,
} from '../lib/adapters/feathers'
import type { AdapterConnectionEvent } from '../lib/adapters/adapter'
import { loadServerOrdering } from '../lib/adapters/feathersSync'
import { Figbird } from '../lib/core/figbird'
import { createSchema, service } from '../lib/core/schema'
import { mockFeathers } from '../lib/testing'
import {
  figbirdSync,
  hybridClock,
  memoryChangeLog,
  versioned,
  type ChangeLog,
  type FigbirdSyncOptions,
  type SyncResult,
  type VersionedOptions,
} from '../lib/server/index'

interface Person {
  id: number
  name: string
  team: string
  secret?: boolean
  archived?: boolean
  tenant?: string
  _v?: number
}

interface Team {
  id: string
  name: string
}

interface Project {
  id: number
  name: string
}

const schema = createSchema({
  services: {
    people: service<{ item: Person }>(),
    projects: service<{ item: Project }>(),
    teams: service<{ item: Team }>(),
  },
})

const EVENTS = ['created', 'updated', 'patched', 'removed'] as const

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const nextTurn = () => new Promise(resolve => setImmediate(resolve))

async function waitFor(condition: () => boolean): Promise<void> {
  for (let turn = 0; !condition(); turn++) {
    if (turn > 1000) throw new Error('waitFor: condition never held')
    await nextTurn()
  }
}

async function createServer({
  log = memoryChangeLog(),
  hideSecret = false,
  versioning,
  sync,
}: {
  log?: ChangeLog
  hideSecret?: boolean
  versioning?: Partial<VersionedOptions>
  sync?: Partial<FigbirdSyncOptions>
} = {}): Promise<Application> {
  const app = feathers()
  app.use('people', new MemoryService<Person>({ paginate: { default: 10, max: 100 }, multi: true }))
  if (hideSecret) {
    app.service('people').hooks({
      before: {
        find: [
          context => {
            if (context.params.provider) {
              context.params.query = { ...context.params.query, secret: { $ne: true } }
            }
          },
        ],
      },
    })
  }
  const sequencer = hybridClock()
  app.service('people').hooks(versioned({ sequencer, log, ...versioning }))
  app.use('projects', new MemoryService<Project>())
  app.service('projects').hooks(versioned({ sequencer, log, ...versioning }))
  // Unversioned: its changes are never logged.
  app.use('teams', new MemoryService<Team>())
  app.use(
    'figbird/sync',
    figbirdSync({
      log,
      sequencer,
      services: ['people', 'projects'],
      ordering: { people: { preset: 'postgres', numeric: ['salary'] } },
      ...sync,
    }),
  )
  await app.setup()
  return app
}

/**
 * A socket-shaped bridge between the server app and a client: payloads are
 * JSON-cloned, calls run as an external provider, realtime events are dropped
 * while disconnected, and reconnecting emits `reconnect` on `client.io`.
 */
function connect(
  app: Application,
  {
    canSee = () => true,
    user,
  }: { canSee?: (row: Person) => boolean; user?: Record<string, unknown> } = {},
) {
  const socket = new EventEmitter()
  const listeners = new Map<string, EventEmitter>()
  const calls: Record<string, number> = {}
  const syncResults: SyncResult[] = []
  let connected = true
  let pending = 0
  let holdSync: Promise<void> | undefined

  for (const path of ['people', 'projects', 'teams']) {
    for (const event of EVENTS) {
      app.service(path).on(event, (row: Person) => {
        if (connected && canSee(row)) listeners.get(path)?.emit(event, clone(row))
      })
    }
  }

  const call = async (path: string, method: string, args: unknown[]): Promise<unknown> => {
    const key = `${path}.${method}`
    calls[key] = (calls[key] ?? 0) + 1
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const target = app.service(path) as any
    const params = { ...(clone(args.at(-1)) as object), provider: 'socketio', user }
    pending++
    try {
      if (!connected) throw Object.assign(new Error('Timeout'), { name: 'Timeout', code: 408 })
      const result = clone(await target[method](...clone(args.slice(0, -1)), params))
      if (path === 'figbird/sync' && method === 'find') {
        syncResults.push(result as SyncResult)
        await holdSync
      }
      return result
    } catch (error) {
      const { name, code, message } = error as { name: string; code?: number; message: string }
      throw Object.assign(new Error(message), { name, code })
    } finally {
      pending--
    }
  }

  const services = new Map<string, FeathersService>()
  const client: FeathersClient = {
    io: socket,
    service(path) {
      let service = services.get(path)
      if (!service) {
        let events = listeners.get(path)
        if (!events) listeners.set(path, (events = new EventEmitter()))
        service = {
          get: (id, params = {}) => call(path, 'get', [id, params]),
          find: (params = {}) =>
            call(path, 'find', [params]) as ReturnType<FeathersService['find']>,
          create: (data: unknown, params = {}) => call(path, 'create', [data, params]),
          update: (id, data, params = {}) => call(path, 'update', [id, data, params]),
          patch: (id, data, params = {}) => call(path, 'patch', [id, data, params]),
          remove: (id, params = {}) => call(path, 'remove', [id, params]),
          on: (event, listener) => void events.on(event, listener),
          off: (event, listener) => void events.off(event, listener),
        } as FeathersService
        services.set(path, service)
      }
      return service
    },
  }

  return {
    client,
    calls,
    syncResults,
    /** Wait until no request is in flight across two consecutive turns. */
    async idle() {
      for (let quiet = 0, turn = 0; quiet < 2; turn++) {
        if (turn > 1000) throw new Error('idle: requests never settled')
        await nextTurn()
        quiet = pending === 0 ? quiet + 1 : 0
      }
    },
    deliver(path: string, event: string, row: unknown) {
      listeners.get(path)?.emit(event, clone(row))
    },
    disconnect() {
      connected = false
      socket.emit('disconnect', 'transport close')
    },
    reconnect({ hold }: { hold?: Promise<void> } = {}) {
      connected = true
      holdSync = hold
      socket.emit('reconnect')
    },
  }
}

async function mount(
  bridge: ReturnType<typeof connect>,
  adapterOptions: FeathersAdapterOptions = { sync: {} },
) {
  const figbird = new Figbird({
    schema,
    adapter: new FeathersAdapter(bridge.client, adapterOptions),
    eventBatchInterval: 0,
    reconnectJitter: 0,
    retry: false,
  })
  const everyone = figbird.query(figbird.q.people.all())
  const teamA = figbird.query(figbird.q.people.where({ team: 'a' }))
  const releases = [everyone.subscribe(() => {}), teamA.subscribe(() => {})]
  await Promise.all([everyone.suspensePromise(), teamA.suspensePromise()])
  const names = (ref: typeof everyone | typeof teamA) =>
    (ref.getSnapshot()?.data ?? []).map(person => person.name).sort()
  return {
    figbird,
    everyone: () => names(everyone),
    teamA: () => names(teamA),
    dispose() {
      for (const release of releases) release()
      figbird.dispose()
    },
  }
}

test('a reconnect replays missed writes in one sync request instead of refetching', async t => {
  const app = await createServer()
  const people = app.service('people')
  await people.create([
    { id: 1, name: 'Ada', team: 'a' },
    { id: 2, name: 'Bob', team: 'a' },
  ])
  const bridge = connect(app)
  const client = await mount(bridge)
  // A realtime event gives the client its cursor.
  await people.create({ id: 3, name: 'Cy', team: 'b' })
  await bridge.idle()
  const findsBefore = bridge.calls['people.find']

  bridge.disconnect()
  await people.create({ id: 4, name: 'Dee', team: 'a' })
  await people.patch(1, { name: 'Ada Lovelace' })
  await people.remove(2)
  t.deepEqual(client.everyone(), ['Ada', 'Bob', 'Cy'], 'events are missed while disconnected')

  bridge.reconnect()
  await bridge.idle()

  t.deepEqual(client.everyone(), ['Ada Lovelace', 'Cy', 'Dee'])
  t.deepEqual(client.teamA(), ['Ada Lovelace', 'Dee'])
  t.is(bridge.calls['figbird/sync.find'], 1)
  t.is(bridge.calls['people.find'], findsBefore, 'active queries are not refetched')
  client.dispose()
})

test('a replayed reconnect still reconciles a query that failed during the outage', async t => {
  const app = await createServer()
  const people = app.service('people')
  await people.create({ id: 1, name: 'Ada', team: 'a' })
  const bridge = connect(app)
  const client = await mount(bridge)
  await people.create({ id: 2, name: 'Bob', team: 'b' })
  await bridge.idle()

  bridge.disconnect()
  const projects = client.figbird.query(client.figbird.q.projects.all())
  const release = projects.subscribe(() => {})
  await bridge.idle()
  t.is(projects.getSnapshot()?.status, 'error')
  const peopleFinds = bridge.calls['people.find']

  bridge.reconnect()
  await bridge.idle()

  t.deepEqual(bridge.syncResults[0]?.services, ['people', 'projects'], 'the reconnect replayed')
  t.is(projects.getSnapshot()?.status, 'success')
  t.is(bridge.calls['people.find'], peopleFinds, 'settled queries do not refetch')
  release()
  client.dispose()
})

test('a truncated change log falls back to refetching active queries', async t => {
  const app = await createServer({ log: memoryChangeLog({ size: 2 }) })
  const people = app.service('people')
  await people.create({ id: 1, name: 'Ada', team: 'a' })
  const bridge = connect(app)
  const client = await mount(bridge)
  await people.create({ id: 2, name: 'Bob', team: 'a' })
  await bridge.idle()
  const findsBefore = bridge.calls['people.find']!

  bridge.disconnect()
  await people.create({ id: 3, name: 'Cy', team: 'a' })
  await people.patch(1, { name: 'Ada Lovelace' })
  await people.remove(2)
  bridge.reconnect()
  await bridge.idle()

  t.is(bridge.calls['figbird/sync.find'], 1)
  t.deepEqual(bridge.syncResults, [], 'the sync service answered Gone')
  t.true(bridge.calls['people.find']! > findsBefore, 'active queries refetch')
  t.deepEqual(client.everyone(), ['Ada Lovelace', 'Cy'])
  t.deepEqual(client.teamA(), ['Ada Lovelace', 'Cy'])
  client.dispose()
})

test('listening to a service the sync service does not replay falls back to refetching', async t => {
  const app = await createServer()
  await app.service('people').create({ id: 1, name: 'Ada', team: 'a' })
  const bridge = connect(app)
  const client = await mount(bridge)
  const teams = client.figbird.query(client.figbird.q.teams.all())
  const release = teams.subscribe(() => {})
  await teams.suspensePromise()
  await app.service('people').create({ id: 2, name: 'Bob', team: 'a' })
  await bridge.idle()
  const findsBefore = bridge.calls['teams.find']!

  bridge.disconnect()
  await app.service('teams').create({ id: 'a', name: 'Alpha' })
  bridge.reconnect()
  await bridge.idle()

  t.is(bridge.calls['figbird/sync.find'], 1)
  t.deepEqual(bridge.syncResults[0]?.services, ['people'])
  t.true(bridge.calls['teams.find']! > findsBefore, 'active queries refetch')
  t.deepEqual(
    teams.getSnapshot()?.data?.map(team => team.name),
    ['Alpha'],
  )
  release()
  client.dispose()
})

test('an out-of-order event loses to a newer row version without timestamps', async t => {
  const deliverLate = async (adapterOptions: FeathersAdapterOptions) => {
    const app = await createServer()
    const people = app.service('people')
    await people.create({ id: 1, name: 'Ada', team: 'a' })
    const bridge = connect(app)
    const client = await mount(bridge, adapterOptions)
    const first = await people.patch(1, { name: 'Ada King' })
    await people.patch(1, { name: 'Ada Lovelace' })
    // The first event again, delivered late (another node's fan-out, say).
    bridge.deliver('people', 'patched', first)
    const names = client.everyone()
    client.dispose()
    return names
  }

  t.deepEqual(await deliverLate({ sync: {} }), ['Ada Lovelace'])
  t.deepEqual(await deliverLate({}), ['Ada King'], 'without versions the late event wins')
})

test('a refetch recovers a row whose last commit carries the lower version', async t => {
  const app = await createServer()
  const people = app.service('people')
  await people.create({ id: 1, name: 'Ada', team: 'a' })
  // Runs after the version stamp: holds the first patch until the second commits.
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  people.hooks({
    before: {
      patch: [
        async context => void ((context.data as Partial<Person>).team === 'slow' && (await held)),
      ],
    },
  })
  const bridge = connect(app)
  const client = await mount(bridge)

  const slow = people.patch(1, { name: 'Slow', team: 'slow' })
  await people.patch(1, { name: 'Fast' })
  release()
  await slow
  t.deepEqual(client.everyone(), ['Fast'], 'the last commit carries the lower version')

  client.figbird.refetch('people')
  await bridge.idle()
  t.deepEqual(client.everyone(), ['Slow'], 'the refetch shows what the database holds')
  client.dispose()
})

test('in database mode the hooks only log the version the database assigned', async t => {
  const log = memoryChangeLog()
  const app = feathers()
  app.use('rows', new MemoryService<{ id: number; _v?: number }>())
  // Stands in for a database assigning the version inside the write.
  app
    .service('rows')
    .hooks({ before: { create: [context => void (context.data = { ...context.data, _v: 42 })] } })
  const hooks = versioned({ log, sequencer: hybridClock(), assign: 'database' })
  t.deepEqual(hooks.before, {})
  app.service('rows').hooks(hooks)

  await app.service('rows').create({ id: 1 })
  t.deepEqual(log.since(0), [{ seq: 42, service: 'rows', id: 1, type: 'created' }])
})

test('a disconnect during an in-flight replay falls back to refetching', async t => {
  const app = await createServer()
  const people = app.service('people')
  await people.create({ id: 1, name: 'Ada', team: 'a' })
  const bridge = connect(app)
  const client = await mount(bridge)
  await people.create({ id: 2, name: 'Bob', team: 'b' })

  bridge.disconnect()
  let release!: () => void
  bridge.reconnect({ hold: new Promise(resolve => (release = resolve)) })
  await waitFor(() => bridge.syncResults.length === 1)
  bridge.disconnect()
  await people.patch(1, { name: 'Ada Lovelace' })
  bridge.reconnect()
  release()
  await bridge.idle()

  t.deepEqual(client.everyone(), ['Ada Lovelace', 'Bob'])
  client.dispose()
})

test('a replay that fails to apply reports a plain reconnect', async t => {
  const app = await createServer()
  const bridge = connect(app)
  const adapter = new FeathersAdapter(bridge.client, { sync: {} })
  const events: AdapterConnectionEvent[] = []
  adapter.subscribeToConnectionEvents(event => events.push(event))
  let failing = false
  const handler = () => {
    if (failing) throw new Error('handler failed')
  }
  adapter.subscribe('people', {
    created: handler,
    updated: handler,
    patched: handler,
    removed: handler,
  })
  await app.service('people').create({ id: 1, name: 'Ada', team: 'a' })

  failing = true
  bridge.disconnect()
  bridge.reconnect()
  await bridge.idle()

  t.deepEqual(
    events.map(event => [event.type, event.type === 'reconnected' && event.replayed === true]),
    [
      ['disconnected', false],
      ['reconnected', false],
    ],
  )
})

test('a live removal during an in-flight replay is not resurrected', async t => {
  const app = await createServer()
  const people = app.service('people')
  await people.create({ id: 1, name: 'Ada', team: 'a' })
  const bridge = connect(app)
  const client = await mount(bridge)
  await people.create({ id: 2, name: 'Bob', team: 'b' })
  await bridge.idle()

  bridge.disconnect()
  await people.patch(1, { name: 'Ada Lovelace' })
  let release!: () => void
  bridge.reconnect({ hold: new Promise(resolve => (release = resolve)) })
  await waitFor(() => bridge.syncResults.length === 1)
  const replayed = bridge.syncResults[0]?.changes.find(change => change.id === 1)
  t.is(replayed?.item.name, 'Ada Lovelace', 'the replay read the row before its removal')

  await people.remove(1)
  release()
  await bridge.idle()

  t.deepEqual(client.everyone(), ['Bob'])
  client.dispose()
})

test('sync reads rows through the caller’s own permissions', async t => {
  const app = await createServer({ hideSecret: true })
  const people = app.service('people')
  await people.create([
    { id: 1, name: 'Ada', team: 'a' },
    { id: 2, name: 'Bob', team: 'a' },
  ])
  const bridge = connect(app, { canSee: person => !person.secret })
  const client = await mount(bridge)
  await people.create({ id: 3, name: 'Cy', team: 'b' })
  await bridge.idle()

  bridge.disconnect()
  await people.create({ id: 4, name: 'Hidden', team: 'a', secret: true })
  await people.patch(2, { secret: true })
  await people.patch(1, { name: 'Ada Lovelace' })
  bridge.reconnect()
  await bridge.idle()

  const changes = bridge.syncResults[0]!.changes
  t.false(
    changes.some(change => change.item.secret !== undefined || change.item.name === 'Hidden'),
    'no hidden row content is returned',
  )
  t.deepEqual(
    changes
      .filter(change => change.id === 2 || change.id === 4)
      .map(({ id, type }) => ({ id, type })),
    [
      { id: 4, type: 'invalidated' },
      { id: 2, type: 'invalidated' },
    ],
    'rows the caller cannot read are invalidated, id only',
  )
  t.deepEqual(
    client.everyone(),
    ['Ada Lovelace', 'Cy'],
    'a row that became hidden leaves on reconcile',
  )
  t.false(client.figbird.getState().get('people')!.entities.has('4'))
  client.dispose()
})

test('time-based sync defaults need a sequencer that tracks time', t => {
  const log = memoryChangeLog()
  const sequencer = { next: () => 1 }
  t.throws(() => figbirdSync({ log, sequencer, services: [] }), { message: /`overlap`/ })
  t.throws(() => figbirdSync({ log, sequencer, services: [], overlap: 1 }), {
    message: /`maxAge`/,
  })
  t.notThrows(() => figbirdSync({ log, sequencer, services: [], overlap: 1, maxAge: 100 }))
})

test('equal row versions fall through to timestamps', t => {
  const adapter = new FeathersAdapter(mockFeathers({}), { sync: {} })
  t.true(adapter.isItemStale({ id: 1, _v: 5, updatedAt: 2 }, { id: 1, _v: 5, updatedAt: 1 }))
  t.false(adapter.isItemStale({ id: 1, _v: 5, updatedAt: 1 }, { id: 1, _v: 6, updatedAt: 0 }))
})

test('sync only replays changes in the caller’s scope', async t => {
  const app = await createServer({
    versioning: { scope: row => row.tenant as string | undefined },
    sync: { scope: params => (params.user as { tenant: string }).tenant },
  })
  const people = app.service('people')
  const ada = await people.create({ id: 1, name: 'Ada', team: 'a', tenant: 'acme' })
  await people.create({ id: 2, name: 'Eve', team: 'a', tenant: 'globex' })
  await people.remove(2)
  const bridge = connect(app, { user: { tenant: 'acme' } })

  const result = (await bridge.client
    .service('figbird/sync')
    .find({ query: { since: ada._v, services: ['people'] } })) as unknown as SyncResult

  t.deepEqual(
    result.changes.map(change => change.id),
    [1],
  )
  t.is(result.cursor, ada._v, 'other tenants’ writes do not move the cursor')
})

test('a replay is bounded by age and size', async t => {
  const app = await createServer({ sync: { maxChanges: 2 } })
  const people = app.service('people')
  const ada = await people.create({ id: 1, name: 'Ada', team: 'a' })
  const sync = connect(app).client.service('figbird/sync')

  await t.throwsAsync(sync.find({ query: { since: 0 } }), { name: 'Gone' })
  t.is(((await sync.find({ query: { since: ada._v } })) as unknown as SyncResult).changes.length, 1)
  await people.create([
    { id: 2, name: 'Bob', team: 'a' },
    { id: 3, name: 'Cy', team: 'a' },
  ])
  await t.throwsAsync(sync.find({ query: { since: ada._v } }), { name: 'Gone' })
})

test('a row outside the default scope is reconciled, not removed', async t => {
  const app = await createServer()
  const people = app.service('people')
  // A default scope: archived people are only listed when asked for by team.
  people.hooks({
    before: {
      find: [
        context => {
          const query = context.params.query ?? {}
          if (context.params.provider && query.team === undefined) {
            context.params.query = { ...query, archived: { $ne: true } }
          }
        },
      ],
    },
  })
  await people.create({ id: 1, name: 'Ada', team: 'a', archived: true })
  const bridge = connect(app)
  const figbird = new Figbird({
    schema,
    adapter: new FeathersAdapter(bridge.client, { sync: {} }),
    eventBatchInterval: 0,
    reconnectJitter: 0,
  })
  const teamA = figbird.query(figbird.q.people.where({ team: 'a' }))
  const release = teamA.subscribe(() => {})
  await teamA.suspensePromise()
  await people.create({ id: 2, name: 'Bob', team: 'b' })

  bridge.disconnect()
  bridge.reconnect()
  await bridge.idle()

  t.is(bridge.syncResults[0]?.changes.find(change => change.id === 1)?.type, 'invalidated')
  t.deepEqual(
    teamA.getSnapshot()?.data?.map(person => person.name),
    ['Ada'],
  )
  release()
  figbird.dispose()
})

test('loadServerOrdering builds a comparator from the server declarations', async t => {
  const app = await createServer()
  const compare = await loadServerOrdering(connect(app).client)
  const people = (field: string) => ({ serviceName: 'people', field })

  t.true(compare('10', '9', people('salary')) > 0, 'numeric fields compare as numbers')
  t.true(compare('10', '9', people('name')) < 0, 'other fields compare as strings')
  t.true(compare(null, 'a', people('name')) > 0, 'postgres sorts nulls last')
  t.true(compare(null, 'a', { serviceName: 'teams', field: 'name' }) < 0, 'undeclared: default')
})
