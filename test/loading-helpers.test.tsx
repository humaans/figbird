import { mock } from 'node:test'
import type { ExecutionContext } from 'ava'
import { StrictMode, Suspense } from 'react'
import { DelayedFallback, useDebouncedTransition, useDelayedFlag } from '../lib/index.js'
import { dom, it } from './dom.js'

function timedDom(t: ExecutionContext) {
  const d = dom()
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  t.teardown(() => {
    d.unmount()
    mock.timers.reset()
  })
  return {
    ...d,
    advance: (ms: number) => d.act(async () => mock.timers.tick(ms)),
  }
}

function pendingContent(label: string) {
  let ready = false
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  function Content() {
    if (!ready) throw promise
    return <div className='content'>{label}</div>
  }
  return {
    Content,
    finish: () => {
      ready = true
      resolve()
    },
  }
}

it('useDelayedFlag skips short loads and gives the next load its full delay', async t => {
  const { render, advance, $ } = timedDom(t)
  function Indicator({ fetching }: { fetching: boolean }) {
    const visible = useDelayedFlag(fetching, 100)
    return <div className='indicator'>{visible ? 'loading' : 'hidden'}</div>
  }
  const show = (fetching: boolean) =>
    render(
      <StrictMode>
        <Indicator fetching={fetching} />
      </StrictMode>,
    )

  show(true)
  t.is($('.indicator')?.textContent, 'hidden')
  await advance(99)
  show(false)
  await advance(1)
  t.is($('.indicator')?.textContent, 'hidden')

  show(true)
  await advance(99)
  t.is($('.indicator')?.textContent, 'hidden')
  await advance(1)
  t.is($('.indicator')?.textContent, 'loading')
  show(false)
  t.is($('.indicator')?.textContent, 'hidden')
})

it('useDelayedFlag holds a visible spinner through a resumed load without resetting its minimum', async t => {
  const { render, advance, $ } = timedDom(t)
  function Indicator({ fetching }: { fetching: boolean }) {
    const visible = useDelayedFlag(fetching, 100, 300)
    return <div className='indicator'>{visible ? 'loading' : 'hidden'}</div>
  }

  render(<Indicator fetching />)
  await advance(100)
  t.is($('.indicator')?.textContent, 'loading')
  render(<Indicator fetching={false} />)
  await advance(150)
  t.is($('.indicator')?.textContent, 'loading')

  render(<Indicator fetching />)
  await advance(150)
  t.is($('.indicator')?.textContent, 'loading', 'the previous hide timer was cancelled')
  render(<Indicator fetching={false} />)
  t.is($('.indicator')?.textContent, 'hidden', 'the minimum elapsed during the resumed load')

  render(<Indicator fetching />)
  await advance(100)
  render(<Indicator fetching={false} />)
  await advance(299)
  t.is($('.indicator')?.textContent, 'loading')
  await advance(1)
  t.is($('.indicator')?.textContent, 'hidden')
})

it('useDebouncedTransition commits only the latest value after the current delay', async t => {
  const { render, advance, $ } = timedDom(t)
  function Search({ value, delay = 100 }: { value: string; delay?: number }) {
    const search = useDebouncedTransition(value, delay)
    return <div className='search'>{search}</div>
  }

  render(<Search value='initial' />)
  t.is($('.search')?.textContent, 'initial')
  render(<Search value='f' />)
  await advance(50)
  render(<Search value='fig' />)
  await advance(99)
  t.is($('.search')?.textContent, 'initial')
  await advance(1)
  t.is($('.search')?.textContent, 'fig')

  render(<Search value='figbird' />)
  await advance(50)
  render(<Search value='figbird' delay={200} />)
  await advance(199)
  t.is($('.search')?.textContent, 'fig')
  await advance(1)
  t.is($('.search')?.textContent, 'figbird')
})

it('useDebouncedTransition keeps committed content visible while the next value suspends', async t => {
  const { render, advance, flush, $ } = timedDom(t)
  const next = pendingContent('next')
  function Search({ value }: { value: string }) {
    const search = useDebouncedTransition(value, 100)
    return (
      <Suspense fallback={<div className='fallback'>loading</div>}>
        {search === 'next' ? <next.Content /> : <div className='content'>{search}</div>}
      </Suspense>
    )
  }

  render(<Search value='initial' />)
  render(<Search value='next' />)
  await advance(100)
  t.is($('.content')?.textContent, 'initial')
  t.is($('.fallback'), null)
  await flush(next.finish)
  t.is($('.content')?.textContent, 'next')
  t.is($('.fallback'), null)
})

it('DelayedFallback skips fast Suspense loads and delays each new fallback mount', async t => {
  const { render, advance, flush, $ } = timedDom(t)
  const fast = pendingContent('fast')
  const slow = pendingContent('slow')
  const fallback = (
    <DelayedFallback>
      <div className='fallback'>loading</div>
    </DelayedFallback>
  )

  render(
    <StrictMode>
      <Suspense key='fast' fallback={fallback}>
        <fast.Content />
      </Suspense>
    </StrictMode>,
  )
  await advance(249)
  t.is($('.fallback'), null)
  await flush(fast.finish)
  await advance(1)
  t.is($('.content')?.textContent, 'fast')
  t.is($('.fallback'), null)

  render(
    <StrictMode>
      <Suspense key='slow' fallback={fallback}>
        <slow.Content />
      </Suspense>
    </StrictMode>,
  )
  await advance(249)
  t.is($('.fallback'), null)
  await advance(1)
  t.is($('.fallback')?.textContent, 'loading')
  await flush(slow.finish)
  t.is($('.content')?.textContent, 'slow')
  t.is($('.fallback'), null)
})
