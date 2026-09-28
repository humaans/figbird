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
  type SyncResult,
} from '../lib/server/index'

interface Person {
  id: number
  name: string
  team: string
  secret?: boolean
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
}: { log?: ChangeLog; hideSecret?: boolean } = {}): Promise<Application> {
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
  app.service('people').hooks(versioned({ sequencer, log }))
  app.use('projects', new MemoryService<Project>())
  app.service('projects').hooks(versioned({ sequencer, log }))
  // Unversioned: its changes are never logged.
  app.use('teams', new MemoryService<Team>())
  app.use(
    'figbird/sync',
    figbirdSync({
      log,
      sequencer,
      services: ['people', 'projects'],
      ordering: { people: { preset: 'postgres', numeric: ['salary'] } },
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
  { canSee = () => true }: { canSee?: (row: Person) => boolean } = {},
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
    const params = { ...(clone(args.at(-1)) as object), provider: 'socketio' }
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

test('a stale response loses to a newer row version without timestamps', async t => {
  const refetchFromStaleCache = async (adapterOptions: FeathersAdapterOptions) => {
    const app = await createServer()
    const people = app.service('people')
    await people.create({ id: 1, name: 'Ada', team: 'a' })
    // A server-side response cache that serves one outdated page.
    let cached: unknown
    let serveCached = false
    people.hooks({
      after: {
        find: [
          context => {
            if (serveCached) context.result = cached as typeof context.result
            else cached = context.result
          },
        ],
      },
    })
    const bridge = connect(app)
    const client = await mount(bridge, adapterOptions)
    await people.patch(1, { name: 'Ada Lovelace' })
    await bridge.idle()
    serveCached = true
    client.figbird.refetch('people')
    await bridge.idle()
    const names = client.everyone()
    client.dispose()
    return names
  }

  t.deepEqual(await refetchFromStaleCache({ sync: {} }), ['Ada Lovelace'])
  t.deepEqual(
    await refetchFromStaleCache({}),
    ['Ada'],
    'without versions the outdated response wins',
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
      { id: 4, type: 'removed' },
      { id: 2, type: 'removed' },
    ],
    'rows the caller cannot read read as removed',
  )
  t.deepEqual(client.everyone(), ['Ada Lovelace', 'Cy'], 'a row that became hidden leaves')
  t.false(client.figbird.getState().get('people')!.entities.has('4'))
  client.dispose()
})

test('time-based sync defaults need a sequencer that tracks time', t => {
  const log = memoryChangeLog()
  const sequencer = { next: () => 1 }
  t.throws(() => figbirdSync({ log, sequencer, services: [] }), { message: /`overlap`/ })
  t.notThrows(() => figbirdSync({ log, sequencer, services: [], overlap: 100 }))
})

test('equal row versions fall through to timestamps', t => {
  const adapter = new FeathersAdapter(mockFeathers({}), { sync: {} })
  t.true(adapter.isItemStale({ id: 1, _v: 5, updatedAt: 2 }, { id: 1, _v: 5, updatedAt: 1 }))
  t.false(adapter.isItemStale({ id: 1, _v: 5, updatedAt: 1 }, { id: 1, _v: 6, updatedAt: 0 }))
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
