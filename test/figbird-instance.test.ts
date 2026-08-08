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

test('Figbird instance can be created', t => {
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

  t.truthy(figbird)
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
