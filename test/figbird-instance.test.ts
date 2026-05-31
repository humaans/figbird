import test from 'ava'
import { FeathersAdapter } from '../lib/adapters/feathers'
import { Figbird } from '../lib/core/figbird'
import { defineSchema, defineService } from '../lib/core/schema'
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

const schema = defineSchema({
  services: {
    notes: defineService<{ item: Note }>(),
    posts: defineService<{ item: Post }>(),
  },
})

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

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

test('figbird.query defaults to realtime merge updates', async t => {
  const feathers = mockFeathers({
    notes: {
      data: {
        1: { id: 1, content: 'hello' },
      },
    },
  })
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ schema, adapter, eventBatchProcessingInterval: 0 })

  const query = figbird.query({ serviceName: 'notes', method: 'get', resourceId: 1 })
  let resolveInitial: (note: Note) => void = () => {}
  let resolveUpdated: (note: Note) => void = () => {}
  const initialState = new Promise<Note>(resolve => {
    resolveInitial = resolve
  })
  const updatedState = new Promise<Note>(resolve => {
    resolveUpdated = resolve
  })

  const unsubscribe = query.subscribe(state => {
    if (state.status !== 'success') return

    if (state.data.content === 'hello') {
      resolveInitial(state.data)
    } else if (state.data.content === 'realtime') {
      resolveUpdated(state.data)
    }
  })

  t.deepEqual(await initialState, { id: 1, content: 'hello' })

  await feathers.service('notes').patch(1, { content: 'realtime' })

  const updated = await Promise.race([
    updatedState,
    new Promise<null>(resolve => {
      setTimeout(() => resolve(null), 100)
    }),
  ])

  unsubscribe()

  if (!updated) {
    t.fail('Expected direct query to receive realtime update')
    return
  }

  t.like(updated, { id: 1, content: 'realtime' })
})

test('realtime events queued while a batch flushes are not dropped', async t => {
  const feathers = mockFeathers({
    notes: {
      data: {
        1: { id: 1, content: 'initial' },
      },
    },
  })
  const adapter = new FeathersAdapter(feathers, { updatedAtField: () => undefined })
  const figbird = new Figbird({ schema, adapter, eventBatchProcessingInterval: 10 })
  const query = figbird.query({ serviceName: 'notes', method: 'find' })
  const service = feathers.service('notes')

  let resolveInitial: () => void = () => {}
  const initial = new Promise<void>(resolve => {
    resolveInitial = resolve
  })
  let sawInitial = false
  let emittedSecond = false
  const unsubscribe = query.subscribe(state => {
    if (state.status !== 'success') return

    const content = state.data[0]?.content
    if (!sawInitial) {
      sawInitial = true
      resolveInitial()
      return
    }

    if (content === 'first' && !emittedSecond) {
      emittedSecond = true
      service.emit('patched', { id: 1, content: 'second' })
    }
  })

  await initial

  service.emit('patched', { id: 1, content: 'first' })
  await wait(30)

  unsubscribe()

  const snapshot = query.getSnapshot()
  t.is(snapshot?.status, 'success')
  if (snapshot?.status !== 'success') return

  t.is(snapshot.data[0]?.content, 'second')
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
    data: { id: 2, content: 'world' },
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
    id: 1,
    data: { id: 1, content: 'world' },
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

  await figbird.mutate({ serviceName: 'notes', method: 'patch', id: 1, data: { content: 'world' } })

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

  await figbird.mutate({ serviceName: 'notes', method: 'remove', id: 1 })

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
