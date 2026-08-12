import test from 'ava'
import React, { useState } from 'react'
import type { QueryState } from '../lib'
import { createHooks, defineMutationQueue, useAction } from '../lib'
import { createTestApp, dom } from './helpers'
import {
  collectEvents,
  deferred,
  schema,
  services,
  type MockItem,
  type Note,
} from './mutation-test-helpers'

// ----- useAction -----

interface ActionHarness<TArgs extends unknown[], TResult> {
  fn: (...args: TArgs) => Promise<TResult>
}

function renderAction<TArgs extends unknown[], TResult>(harness: ActionHarness<TArgs, TResult>) {
  const d = dom()
  let run!: (...args: TArgs) => Promise<void>
  let reset!: () => void

  function Probe() {
    const action = useAction(harness.fn)
    run = action.run
    reset = action.reset
    return (
      <div>
        <div className='pending'>{String(action.pending)}</div>
        <div className='error'>{action.error ? action.error.message : 'none'}</div>
        <div className='data'>{action.data === null ? 'null' : JSON.stringify(action.data)}</div>
      </div>
    )
  }

  d.render(<Probe />)
  const read = () => ({
    pending: d.$('.pending')!.textContent,
    error: d.$('.error')!.textContent,
    data: d.$('.data')!.textContent,
  })
  return { d, read, run: (...args: TArgs) => run(...args), reset: () => reset() }
}

test('useAction: pending is a counter across overlapping runs; data and args flow through', async t => {
  const gates: Array<ReturnType<typeof deferred<string>>> = []
  const harness: ActionHarness<[string], string> = {
    fn: async (input: string) => {
      const gate = deferred<string>()
      gates.push(gate)
      const value = await gate.promise
      return `${input}:${value}`
    },
  }
  const { d, read, run } = renderAction(harness)

  t.is(read().pending, 'false')

  let first!: Promise<void>
  let second!: Promise<void>
  await d.flush(() => {
    first = run('a')
    second = run('b')
  })
  t.is(read().pending, 'true')

  await d.flush(async () => {
    gates[0]!.resolve('one')
    await first
  })
  // One of two overlapping runs settled — still pending.
  t.is(read().pending, 'true')
  t.is(read().data, '"a:one"')

  await d.flush(async () => {
    gates[1]!.resolve('two')
    await second
  })
  t.is(read().pending, 'false')
  t.is(read().data, '"b:two"')
})

test('useAction: run never rejects; error is a slot cleared when a new run starts; reset clears it', async t => {
  const gates: Array<ReturnType<typeof deferred<string>>> = []
  const harness: ActionHarness<[], string> = {
    fn: () => {
      const gate = deferred<string>()
      gates.push(gate)
      return gate.promise
    },
  }
  const { d, read, run, reset } = renderAction(harness)

  let first!: Promise<void>
  await d.flush(() => {
    first = run()
  })
  await d.flush(async () => {
    gates[0]!.reject(new Error('first failure'))
    // run() captures the failure instead of rejecting.
    await t.notThrowsAsync(first)
  })
  t.is(read().error, 'first failure')
  t.is(read().pending, 'false')

  // Starting a new run clears the stale error immediately.
  let second!: Promise<void>
  await d.flush(() => {
    second = run()
  })
  t.is(read().error, 'none')
  t.is(read().pending, 'true')

  await d.flush(async () => {
    gates[1]!.reject(new Error('second failure'))
    await second
  })
  t.is(read().error, 'second failure')

  await d.flush(() => reset())
  t.is(read().error, 'none')
  t.is(read().data, 'null')
})

test('useAction: the action body sees the current render closure without a deps array', async t => {
  const d = dom()
  const results: string[] = []
  let run!: () => Promise<void>
  let bump!: () => void

  function Probe() {
    const [label, setLabel] = useState('initial')
    const action = useAction(async () => {
      results.push(label)
    })
    run = action.run
    bump = () => setLabel('updated')
    return <div className='pending'>{String(action.pending)}</div>
  }

  d.render(<Probe />)
  await d.flush(() => run())
  await d.flush(() => bump())
  await d.flush(() => run())
  t.deepEqual(results, ['initial', 'updated'])
})

test('useAction: settling after unmount does not update state', async t => {
  const gate = deferred<string>()
  const harness: ActionHarness<[], string> = { fn: () => gate.promise }
  const { d, run } = renderAction(harness)

  let pending!: Promise<void>
  await d.flush(() => {
    pending = run()
  })
  d.unmount()
  gate.resolve('late')
  await t.notThrowsAsync(pending)
})

test('useAction (kit): named actions report action:start/end/error through the bound instance', async t => {
  const { App, figbird } = createTestApp(schema, services())
  const { useAction: useKitAction } = createHooks(figbird)
  const events = collectEvents(figbird, 'action:')

  const d = dom()
  let succeed!: () => Promise<void>
  let fail!: () => Promise<void>

  function Probe() {
    const ok = useKitAction('boost', async () => 'done')
    const bad = useKitAction('explode', async () => {
      throw new Error('kaboom')
    })
    succeed = ok.run
    fail = bad.run
    return <div className='pending'>{String(ok.pending || bad.pending)}</div>
  }

  d.render(
    <App>
      <Probe />
    </App>,
  )

  await d.flush(async () => {
    await succeed()
    await fail()
  })
  await d.flush()

  const summary = events.map(e => `${e.kind}:${'name' in e ? e.name : ''}`)
  t.deepEqual(summary, [
    'action:start:boost',
    'action:end:boost',
    'action:start:explode',
    'action:error:explode',
  ])
  const [start, end] = events as Array<{ actionId: number }>
  t.is(start!.actionId, end!.actionId, 'start/end correlate per invocation')
  const errorEvent = events.find(e => e.kind === 'action:error')
  t.is((errorEvent as { error: Error }).error.message, 'kaboom')
})

// ----- form action interop -----

test('useAction: run works as a React 19 <form action>', async t => {
  const d = dom()
  // React builds `new FormData(form)` via the global constructor; Node's
  // built-in (undici) FormData can't read a jsdom form — use jsdom's.
  const g = globalThis as { FormData?: unknown; window?: Window }
  const prevFormData = g.FormData
  g.FormData = (g.window as unknown as { FormData: unknown }).FormData
  t.teardown(() => {
    g.FormData = prevFormData
  })

  const received: Array<string | null> = []
  let pendingText = ''

  function Probe() {
    const submit = useAction(async (formData: FormData) => {
      received.push(formData.get('title') as string | null)
    })
    pendingText = String(submit.pending)
    return (
      <form action={submit.run}>
        <input name='title' defaultValue='hello form' />
        <button type='submit'>Go</button>
      </form>
    )
  }

  d.render(<Probe />)
  await d.flush(async () => {
    const form = d.$('form') as HTMLFormElement
    form.requestSubmit()
    // React dispatches form actions on a transition lane — give it a beat.
    await new Promise(r => setTimeout(r, 20))
  })

  t.deepEqual(received, ['hello form'])
  t.is(pendingText, 'false')
})

// ----- useMutationQueue -----

test('useMutationQueue: updates unkeyed policy and reconnects definition-keyed owners', async t => {
  const { App, figbird, feathers } = createTestApp(schema, services())
  const { useMutationQueue: useQueue } = createHooks(figbird)
  const d = dom()
  let queue!: ReturnType<typeof useQueue>
  let makeImmediate!: () => void

  function Probe() {
    const [immediate, setImmediate] = useState(false)
    queue = useQueue({ schedule: () => ({ wait: immediate ? 0 : 10_000 }) })
    makeImmediate = () => setImmediate(true)
    return <div className='status'>{queue.status}</div>
  }

  d.render(
    <App>
      <Probe />
    </App>,
  )
  const originalQueue = queue
  await d.flush(() => makeImmediate())
  t.is(queue, originalQueue)

  await d.flush(async () => {
    await queue.m.notes.patch(1, { content: 'uses latest config' })
  })
  t.is(feathers.service('notes').counts.patch, 1)
  d.unmount()

  const gate = deferred<MockItem>()
  feathers.service('notes').patch = (() => gate.promise) as never
  const noteEditorQueue = defineMutationQueue({ schedule: () => ({ wait: 0 }) })
  let keyedQueue!: ReturnType<typeof useQueue>
  function KeyedProbe() {
    keyedQueue = useQueue(noteEditorQueue, 'note-editor')
    return <div className='status'>{keyedQueue.status}</div>
  }

  const firstOwner = dom()
  firstOwner.render(
    <App>
      <KeyedProbe />
    </App>,
  )
  const originalKeyedQueue = keyedQueue

  const unrelatedDefinition = defineMutationQueue({ retry: 1 })
  let unrelatedQueue!: ReturnType<typeof useQueue>
  function UnrelatedProbe() {
    unrelatedQueue = useQueue(unrelatedDefinition, 'note-editor')
    return null
  }
  const unrelatedOwner = dom()
  unrelatedOwner.render(
    <App>
      <UnrelatedProbe />
    </App>,
  )
  t.not(unrelatedQueue, originalKeyedQueue, 'definitions namespace equal string keys')
  unrelatedOwner.unmount()

  let pending!: Promise<Note>
  await firstOwner.act(() => {
    pending = keyedQueue.m.notes.patch(1, { content: 'survives navigation' })
  })
  t.is(keyedQueue.status, 'saving')
  firstOwner.unmount()
  await Promise.resolve()

  const secondOwner = dom()
  secondOwner.render(
    <App>
      <KeyedProbe />
    </App>,
  )
  t.is(keyedQueue, originalKeyedQueue)
  t.is(keyedQueue.pending, 1)
  t.is(keyedQueue.status, 'saving')

  await secondOwner.act(async () => {
    gate.resolve({ id: 1, content: 'survives navigation' })
    await pending
  })
  t.is(keyedQueue.status, 'idle')
  secondOwner.unmount()
  await Promise.resolve()

  const thirdOwner = dom()
  thirdOwner.render(
    <App>
      <KeyedProbe />
    </App>,
  )
  t.not(keyedQueue, originalKeyedQueue, 'an unowned idle keyed queue is evicted')
  thirdOwner.unmount()
})

test('useMutationQueue: unmount flushes work and cannot strand a failed optimistic lane', async t => {
  const { App, figbird, feathers } = createTestApp(schema, services())
  const { useMutationQueue: useQueue } = createHooks(figbird)
  const ref = figbird.queryDesc({ serviceName: 'notes', method: 'find' })
  let latest: QueryState<Note[], Record<string, unknown>> | undefined
  ref.subscribe(state => {
    latest = state as QueryState<Note[], Record<string, unknown>>
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  feathers.service('notes').patch = (() => Promise.reject(new Error('offline'))) as never

  const d = dom()
  let queue!: ReturnType<typeof useQueue>
  function Probe() {
    queue = useQueue({ schedule: () => ({ wait: 10_000 }) })
    return null
  }
  d.render(
    <App>
      <Probe />
    </App>,
  )

  let pending!: Promise<Note>
  await d.act(() => {
    pending = queue.m.notes.patch(1, { content: 'unsaved' })
  })
  t.is(latest?.data?.find(note => note.id === 1)?.content, 'unsaved')
  d.unmount()
  await t.throwsAsync(() => pending, { message: 'offline' })
  await Promise.resolve()

  t.is(latest?.data?.find(note => note.id === 1)?.content, 'hello')
  t.is(figbird.mutating.getSnapshot().length, 0)
  t.is(queue.status, 'idle')
})

// ----- useMutating -----

function renderMutating(
  App: React.ComponentType<{ children?: React.ReactNode }>,
  hook: () => boolean,
) {
  const d = dom()
  function Probe() {
    return <div className='busy'>{String(hook())}</div>
  }
  d.render(
    <App>
      <Probe />
    </App>,
  )
  return { d, read: () => d.$('.busy')!.textContent }
}

test('useMutating: reflects in-flight mutations by service and id, including custom methods', async t => {
  const { App, figbird, feathers } = createTestApp(schema, services())
  const { m, useMutating } = createHooks(figbird)

  const gate = deferred<MockItem>()
  feathers.service('notes').patch = () => gate.promise

  const anyMutation = renderMutating(App, () => useMutating())
  const noteOne = renderMutating(App, () => useMutating({ service: 'notes', id: 1 }))
  const noteTwo = renderMutating(App, () => useMutating({ service: 'notes', id: 2 }))
  const byMethod = renderMutating(App, () => useMutating({ service: 'notes', method: 'patch' }))

  t.is(anyMutation.read(), 'false')

  let pending!: Promise<Note>
  await anyMutation.d.act(() => {
    pending = m.notes.patch(1, { content: 'busy' })
  })

  t.is(anyMutation.read(), 'true')
  t.is(noteOne.read(), 'true')
  t.is(noteTwo.read(), 'false')
  t.is(byMethod.read(), 'true')

  await anyMutation.d.flush(async () => {
    gate.resolve({ id: 1, content: 'busy' })
    await pending
  })

  t.is(anyMutation.read(), 'false')
  t.is(noteOne.read(), 'false')
  t.is(byMethod.read(), 'false')
})

test('useMutating: a component that mounts while a mutation is already in flight reports true', async t => {
  const { App, figbird, feathers } = createTestApp(schema, services())
  const { m, useMutating } = createHooks(figbird)

  const gate = deferred<MockItem>()
  feathers.service('notes').patch = () => gate.promise

  // Start the mutation BEFORE any subscriber exists — an events-based
  // implementation would miss the start and report false here.
  const pending = m.notes.patch(1, { content: 'early' })

  const probe = renderMutating(App, () => useMutating({ service: 'notes' }))
  t.is(probe.read(), 'true')

  await probe.d.flush(async () => {
    gate.resolve({ id: 1, content: 'early' })
    await pending
  })
  t.is(probe.read(), 'false')
})

test('useMutating: service filter resolves schema aliases to transport paths', async t => {
  const { App, figbird, feathers } = createTestApp(schema, services())
  const { m, useMutating } = createHooks(figbird)

  const gate = deferred<{ id: number; name: string }>()
  feathers.service('api/people').patch = () => gate.promise

  // Filter by schema key; the tracker records the resolved 'api/people' path.
  const probe = renderMutating(App, () => useMutating({ service: 'people' }))
  t.is(probe.read(), 'false')

  let pending!: Promise<{ id: number; name: string }>
  await probe.d.act(() => {
    pending = m.people.patch(1, { name: 'Grace' })
  })
  t.is(probe.read(), 'true')

  await probe.d.flush(async () => {
    gate.resolve({ id: 1, name: 'Grace' })
    await pending
  })
  t.is(probe.read(), 'false')
})
