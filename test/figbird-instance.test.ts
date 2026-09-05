import test from 'ava'
import { FeathersAdapter } from '../lib/adapters/feathers'
import { Figbird } from '../lib/core/figbird'
import { createSchema, service } from '../lib/core/schema'
import type { FindResult } from '../lib/testing'
import { mockFeathers } from './helpers'

interface Note {
  id: number
  content: string
  tag?: string
  updatedAt?: number
}

interface Post {
  id: number
  title: string
  body: string
  updatedAt?: number
}

const schema = createSchema({
  services: {
    notes: service<{ item: Note }>(),
    posts: service<{ item: Post }>(),
  },
})

test('Figbird instance retains idle queries and releases owned resources on disposal', async t => {
  const feathers = mockFeathers({
    notes: {
      data: {
        1: { id: 1, content: 'hello' },
      },
    },
    posts: {
      data: {
        1: { id: 1, title: 'post title', body: 'post body' },
      },
    },
  })
  const adapter = new FeathersAdapter(feathers)
  let realtimeSubscriptions = 0
  let visibilitySubscriptions = 0
  let connectionSubscriptions = 0
  const subscribe = adapter.subscribe.bind(adapter)
  adapter.subscribe = (name, handlers) => {
    realtimeSubscriptions++
    const unsubscribe = subscribe(name, handlers)
    return () => {
      realtimeSubscriptions--
      unsubscribe()
    }
  }
  adapter.subscribeToConnectionEvents = () => {
    connectionSubscriptions++
    return () => {
      connectionSubscriptions--
    }
  }
  const figbird = new Figbird({
    schema,
    adapter,
    gcTime: 10,
    visibility: {
      isHidden: () => false,
      onChange: () => {
        visibilitySubscriptions++
        return () => {
          visibilitySubscriptions--
        }
      },
    },
  })
  const ref = figbird.query(figbird.q.notes)
  const unsubscribe = ref.subscribe(() => {})
  await ref.suspensePromise()
  const idleQueue = figbird.createMutationQueue({ schedule: () => ({ wait: 10_000 }) })
  const idleWrite = idleQueue.m.notes.patch(1, { content: 'saved after expiry' })
  unsubscribe()
  t.true(figbird.inspect().length > 0, 'idle cache survives immediate unmount')
  await new Promise(resolve => setTimeout(resolve, 30))
  t.is(figbird.inspect().length, 0, 'idle queries expire')
  t.is(figbird.getState().get('notes')?.entities.size, 1, 'pending mutation retains its row')
  t.is(realtimeSubscriptions, 1)
  idleQueue.flush()
  await idleWrite
  t.is(figbird.getState().size, 0, 'unreferenced entities and services expire')
  t.is(realtimeSubscriptions, 0)

  await figbird.m.notes.patch(1, { content: 'written without a query' })
  t.is(figbird.getState().size, 0, 'settled writes release services recreated after expiry')
  await figbird.m.notes.create([{ id: 2, content: 'created without a query' }])
  t.is(figbird.getState().size, 0, 'unkeyed writes release unreferenced entities too')

  const all = figbird.query(figbird.q.notes.all())
  const releaseAll = all.subscribe(() => {})
  await all.suspensePromise()
  releaseAll()
  await new Promise(resolve => setTimeout(resolve, 30))
  t.true(figbird.getState().has('notes'), 'complete materializations remain available')

  const queue = figbird.createMutationQueue({ schedule: () => ({ wait: 10_000 }) })
  const pending = queue.m.notes.patch(1, { content: 'saved during disposal' })
  const second = queue.m.notes.patch(1, { content: 'second write' })
  figbird.dispose()
  figbird.dispose()
  await Promise.all([pending, second])
  t.is(feathers.service('notes').data[1]?.content, 'second write')
  t.is(figbird.getState().size, 0, 'late writes cannot resurrect the disposed cache')
  t.is(realtimeSubscriptions, 0)
  t.is(visibilitySubscriptions, 0)
  t.is(connectionSubscriptions, 0)
  t.throws(() => figbird.query(figbird.q.notes), { message: /disposed/ })
  t.throws(() => figbird.m.notes.patch(1, { content: 'too late' }), { message: /disposed/ })
  t.throws(() => new Figbird({ adapter, schema, gcTime: -1 }), { message: /gcTime/ })
})

test('figbird.query with get returns typed data', async t => {
  const feathers = mockFeathers({
    notes: {
      data: {
        1: { id: 1, content: 'hello' },
      },
    },
    posts: {
      data: {
        1: { id: 1, title: 'post title', body: 'post body' },
      },
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })

  const query = figbird.queryDesc({ serviceName: 'notes', method: 'get', resourceId: 1 })
  const result = await new Promise(resolve => {
    query.subscribe(state => {
      if (state.status === 'success') {
        resolve(state.data)
      }
    })
  })

  t.deepEqual(result, { id: 1, content: 'hello' })
})

test('figbird.query with find returns typed data', async t => {
  const feathers = mockFeathers({
    notes: {
      data: {
        1: { id: 1, content: 'hello' },
      },
    },
    posts: {
      data: {
        1: { id: 1, title: 'post title', body: 'post body' },
      },
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })

  const query = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const result = await new Promise(resolve => {
    query.subscribe(state => {
      if (state.status === 'success') {
        resolve(state.data)
      }
    })
  })

  t.deepEqual(result, [{ id: 1, content: 'hello' }])
})

test('figbird.query with get returns typed data for the second service', async t => {
  const feathers = mockFeathers({
    notes: {
      data: {
        1: { id: 1, content: 'hello' },
      },
    },
    posts: {
      data: {
        1: { id: 1, title: 'post title', body: 'post body' },
      },
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })

  const query = figbird.queryDesc({ serviceName: 'posts', method: 'get', resourceId: 1 })
  const result = await new Promise(resolve => {
    query.subscribe(state => {
      if (state.status === 'success') {
        resolve(state.data)
      }
    })
  })

  t.deepEqual(result, { id: 1, title: 'post title', body: 'post body' })
})

test('figbird.query with find returns typed data for the second service', async t => {
  const feathers = mockFeathers({
    notes: {
      data: {
        1: { id: 1, content: 'hello' },
      },
    },
    posts: {
      data: {
        1: { id: 1, title: 'post title', body: 'post body' },
      },
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter })

  const query = figbird.queryDesc({ serviceName: 'posts', method: 'find' })
  const result = await new Promise(resolve => {
    query.subscribe(state => {
      if (state.status === 'success') {
        resolve(state.data)
      }
    })
  })

  t.deepEqual(result, [{ id: 1, title: 'post title', body: 'post body' }])
})

test('figbird.query with get returns any data when no schema is provided', async t => {
  const feathers = mockFeathers({
    notes: {
      data: {
        1: { id: 1, content: 'hello' },
      },
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter })

  const query = figbird.queryDesc({ serviceName: 'notes', method: 'get', resourceId: 1 })
  const result = await new Promise(resolve => {
    query.subscribe(state => {
      if (state.status === 'success') {
        resolve(state.data)
      }
    })
  })

  t.deepEqual(result, { id: 1, content: 'hello' })
})

test('figbird.query with find returns any data when no schema is provided', async t => {
  const feathers = mockFeathers({
    notes: {
      data: {
        1: { id: 1, content: 'hello' },
      },
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter })

  const query = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const result = await new Promise(resolve => {
    query.subscribe(state => {
      if (state.status === 'success') {
        resolve(state.data)
      }
    })
  })

  t.deepEqual(result, [{ id: 1, content: 'hello' }])
})

test('figbird.mutate with create', async t => {
  const feathers = mockFeathers({
    notes: {
      data: {
        1: { id: 1, content: 'hello' },
      },
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter })

  await figbird.mutateDesc({
    serviceName: 'notes',
    method: 'create',
    data: { id: 2, content: 'world' },
  })

  const query = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const result = await new Promise(resolve => {
    query.subscribe(state => {
      if (state.status === 'success') {
        resolve(state.data)
      }
    })
  })

  t.like(result, [
    { id: 1, content: 'hello' },
    { id: 2, content: 'world' },
  ])
})

test('figbird.mutate with update', async t => {
  const feathers = mockFeathers({
    notes: {
      data: {
        1: { id: 1, content: 'hello' },
      },
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter })

  await figbird.mutateDesc({
    serviceName: 'notes',
    method: 'update',
    id: 1,
    data: { id: 1, content: 'world' },
  })

  const query = figbird.queryDesc({ serviceName: 'notes', method: 'get', resourceId: 1 })
  const result = await new Promise(resolve => {
    query.subscribe(state => {
      if (state.status === 'success') {
        resolve(state.data)
      }
    })
  })

  t.like(result, { id: 1, content: 'world' })
})

test('figbird.mutate with patch', async t => {
  const feathers = mockFeathers({
    notes: {
      data: {
        1: { id: 1, content: 'hello' },
      },
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter })

  await figbird.mutateDesc({
    serviceName: 'notes',
    method: 'patch',
    id: 1,
    data: { content: 'world' },
  })

  const query = figbird.queryDesc({ serviceName: 'notes', method: 'get', resourceId: 1 })
  const result = await new Promise(resolve => {
    query.subscribe(state => {
      if (state.status === 'success') {
        resolve(state.data)
      }
    })
  })

  t.like(result, { id: 1, content: 'world' })
})

test('figbird.mutate with remove', async t => {
  const feathers = mockFeathers({
    notes: {
      data: {
        1: { id: 1, content: 'hello' },
      },
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter })

  await figbird.mutateDesc({ serviceName: 'notes', method: 'remove', id: 1 })

  const query = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const result = await new Promise(resolve => {
    query.subscribe(state => {
      if (state.status === 'success') {
        resolve(state.data)
      }
    })
  })

  t.deepEqual(result, [])
})

test('figbird.refetch coalesces an in-flight query into one follow-up fetch', async t => {
  const feathers = mockFeathers({ notes: { data: {} } })
  const notes = feathers.service('notes')
  const pending: Array<(result: FindResult) => void> = []
  let findCalls = 0
  notes.find = () => {
    findCalls++
    return new Promise<FindResult>(resolve => pending.push(resolve))
  }

  const figbird = new Figbird({
    schema,
    adapter: new FeathersAdapter(feathers),
    reconnectJitter: 0,
  })
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  const unsub = ref.subscribe(() => {})
  t.is(findCalls, 1)

  figbird.refetch('notes')
  t.is(findCalls, 1, 'no duplicate fetch starts in the current generation')

  pending.shift()!({
    data: [{ id: 1, content: 'stale' }],
    total: 1,
    limit: 100,
    skip: 0,
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  t.is(findCalls, 2, 'one dirty follow-up starts after the first fetch settles')

  pending.shift()!({
    data: [{ id: 1, content: 'latest' }],
    total: 1,
    limit: 100,
    skip: 0,
  })
  await new Promise(resolve => setTimeout(resolve, 0))

  t.deepEqual(ref.getSnapshot()?.data, [{ id: 1, content: 'latest' }])
  unsub()
})
