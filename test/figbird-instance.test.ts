import test from 'ava'
import { FeathersAdapter } from '../lib/adapters/feathers'
import { Figbird } from '../lib/core/figbird'
import { createSchema, service } from '../lib/core/schema'
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

  const query = figbird.query({ serviceName: 'notes', method: 'get', resourceId: 1 })
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

  const query = figbird.query({ serviceName: 'notes', method: 'find' })
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

  const query = figbird.query({ serviceName: 'posts', method: 'get', resourceId: 1 })
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

  const query = figbird.query({ serviceName: 'posts', method: 'find' })
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

  const query = figbird.query({ serviceName: 'notes', method: 'get', resourceId: 1 })
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

  const query = figbird.query({ serviceName: 'notes', method: 'find' })
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

  await figbird.mutate({
    serviceName: 'notes',
    method: 'create',
    args: [{ id: 2, content: 'world' }],
  })

  const query = figbird.query({ serviceName: 'notes', method: 'find' })
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

  await figbird.mutate({
    serviceName: 'notes',
    method: 'update',
    args: [1, { id: 1, content: 'world' }],
  })

  const query = figbird.query({ serviceName: 'notes', method: 'get', resourceId: 1 })
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

  await figbird.mutate({ serviceName: 'notes', method: 'patch', args: [1, { content: 'world' }] })

  const query = figbird.query({ serviceName: 'notes', method: 'get', resourceId: 1 })
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

  await figbird.mutate({ serviceName: 'notes', method: 'remove', args: [1] })

  const query = figbird.query({ serviceName: 'notes', method: 'find' })
  const result = await new Promise(resolve => {
    query.subscribe(state => {
      if (state.status === 'success') {
        resolve(state.data)
      }
    })
  })

  t.deepEqual(result, [])
})
