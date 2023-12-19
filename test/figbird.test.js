import React, { useState, useEffect, StrictMode } from 'react'
import test from 'ava'
import { dom, mockFeathers, swallowErrors } from './helpers'
import { Provider, useGet, useFind, useMutation, useFeathers, createStore } from '../lib'

const createFeathers = () =>
  mockFeathers({
    notes: {
      data: {
        1: {
          id: 1,
          content: 'hello',
          updatedAt: Date.now(),
        },
      },
    },
  })

function App({ feathers, store, config, children }) {
  return (
    <StrictMode>
      <ErrorHandler>
        <Provider feathers={feathers} store={store} {...config}>
          {children}
        </Provider>
      </ErrorHandler>
    </StrictMode>
  )
}

class ErrorHandler extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error: error.message }
  }

  componentDidCatch(error) {
    if (error.message === 'Please pass in a feathers client') {
      return
    }
    throw error
  }

  render() {
    if (this.state.hasError) return <div className='error'>{this.state.error}</div>
    return this.props.children
  }
}

function NoteList({ notes, keyField = 'id' }) {
  if (notes.error) {
    return <div className='error'>{notes.error.message}</div>
  }

  if (notes.status === 'loading') {
    return <div className='spinner'>loading...</div>
  }

  return (
    <>
      {(Array.isArray(notes.data) ? notes.data : [notes.data]).map(note => (
        <div key={note[keyField]} className='note'>
          {note.content}
        </div>
      ))}
    </>
  )
}

test('useGet', async t => {
  const { render, unmount, flush, $ } = dom()

  function Note() {
    const note = useGet('notes', 1)
    return <NoteList notes={note} />
  }

  render(
    <App feathers={createFeathers()}>
      <Note />
    </App>,
  )

  t.is($('.spinner').innerHTML, 'loading...')
  await flush()
  t.is($('.note').innerHTML, 'hello')
  unmount()
})

test('useGet updates after realtime patch', async t => {
  const { render, flush, unmount, $ } = dom()

  function Note() {
    const note = useGet('notes', 1)
    return <NoteList notes={note} />
  }

  const feathers = createFeathers()

  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  t.is($('.spinner').innerHTML, 'loading...')

  await flush()

  t.is($('.note').innerHTML, 'hello')

  await flush(async () => {
    await feathers.service('notes').patch(1, { content: 'realtime' })
  })

  t.is($('.note').innerHTML, 'realtime')

  unmount()
})

test('useFind', async t => {
  const { render, flush, unmount, $ } = dom()

  function Note() {
    const notes = useFind('notes')
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.note').innerHTML, 'hello')

  unmount()
})

test('useFind binding updates after realtime create', async t => {
  const { render, flush, unmount, $, $all } = dom()

  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' } })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.note').innerHTML, 'hello')

  await flush(async () => {
    await feathers.service('notes').create({ id: 2, content: 'doc', tag: 'idea' })
    await feathers.service('notes').create({ id: 3, content: 'dmc', tag: 'unrelated' })
  })

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello', 'doc'],
  )

  unmount()
})

test('useFind binding updates after realtime patch', async t => {
  const { render, flush, unmount, $, $all } = dom()
  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' } })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.note').innerHTML, 'hello')

  await flush(async () => {
    await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })
  })

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['doc'],
  )

  unmount()
})

test('useFind binding updates after realtime update', async t => {
  const { render, flush, unmount, $all } = dom()
  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' } })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello'],
  )

  await flush(async () => {
    await feathers.service('notes').update(1, { id: 1, content: 'doc', tag: 'idea' })
  })

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['doc'],
  )

  unmount()
})

test('useFind binding updates after realtime remove', async t => {
  const { render, flush, unmount, $all } = dom()
  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' } })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  await feathers.service('notes').create({ id: 2, content: 'doc', tag: 'idea' })

  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello', 'doc'],
  )

  await flush(async () => {
    await feathers.service('notes').remove(1)
  })

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['doc'],
  )

  unmount()
})

test('useFind binding updates after realtime patch with no query', async t => {
  const { render, flush, unmount, $, $all } = dom()
  function Note() {
    const notes = useFind('notes')
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.note').innerHTML, 'hello')

  await flush(async () => {
    await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })
  })

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['doc'],
  )

  unmount()
})

test('useRealtime listeners are correctly disposed of', async t => {
  const store = createStore()

  const { render, flush, unmount, $, $all } = dom()

  function Note1() {
    const notes = useFind('notes')
    return <div className='note1'>{notes.data && notes.data[0].content}</div>
  }

  function Note2() {
    const notes = useFind('notes')
    return <div className='note2'>{notes.data && notes.data[0].content}</div>
  }

  function Notes() {
    const [counter, setCounter] = useState(0)

    useEffect(() => {
      if (counter >= 2) {
        return
      }
      setCounter(counter => counter + 1)
    }, [counter])

    if (counter === 0) {
      return (
        <>
          <Note1 />
        </>
      )
    }

    if (counter === 1) {
      return (
        <>
          <Note1 />
          <Note2 />
        </>
      )
    }

    if (counter === 2) {
      return (
        <>
          <Note2 />
        </>
      )
    }

    return null
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers} store={store}>
      <Notes />
    </App>,
  )

  await flush()

  t.is($('.note2').innerHTML, 'hello')
  t.is(store.debug().figbird.entities.notes[1].content, 'hello')

  await flush(async () => {
    await feathers.service('notes').patch(1, { content: 'real' })
  })
  t.is(store.debug().figbird.entities.notes[1].content, 'real')

  t.deepEqual(
    $all('.note2').map(n => n.innerHTML),
    ['real'],
  )

  unmount()

  await flush(async () => {
    await feathers.service('notes').patch(1, { content: 'nomo' })
  })

  // should not have updated!
  t.is(store.debug().figbird.entities.notes[1].content, 'real')
})

test('useMutation - multicreate updates cache correctly', async t => {
  const { render, flush, unmount, $all } = dom()
  let create

  function Note() {
    const notes = useFind('notes')
    const { create: _create } = useMutation('notes')
    create = _create

    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  await flush(() => {
    create([
      { id: 2, content: 'hi2' },
      { id: 3, content: 'hi3' },
    ])
  })

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello', 'hi2', 'hi3'],
  )

  unmount()
})

test('useMutation patch updates the get binding', async t => {
  const { render, flush, unmount, $ } = dom()
  let setContent

  function Note() {
    const note = useGet('notes', 1)
    const { patch } = useMutation('notes')
    const [content, _setContent] = useState('hi1')
    setContent = _setContent

    const [loaded, setLoaded] = useState(false)

    useEffect(() => {
      if (note.data && !loaded) {
        setLoaded(true)
      }
    }, [note.data, loaded])

    useEffect(() => {
      if (loaded) {
        patch(1, { content })
      }
    }, [patch, loaded, content])

    return <NoteList notes={note} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.note').innerHTML, 'hi1')

  await flush(() => {
    setContent('hi2')
  })

  t.is($('.note').innerHTML, 'hi2')

  unmount()
})

test('useMutation handles errors', async t => {
  const { render, flush, unmount, $ } = dom()

  let handled = false

  function Note() {
    const note = useGet('notes', 1)
    const { patch, error } = useMutation('notes')

    useEffect(() => {
      patch(1, {
        content: 'hi',
      }).catch(err => {
        handled = err.message
      })
    }, [patch])

    return <NoteList notes={{ ...note, error }} />
  }

  const feathers = createFeathers()
  feathers.service('notes').patch = () => {
    return Promise.reject(new Error('unexpected'))
  }
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.error').innerHTML, 'unexpected')

  t.is(handled, 'unexpected')

  unmount()
})

test('useFeathers', async t => {
  const { render, flush, unmount } = dom()

  let feathersFromHook

  function Content() {
    const feathers = useFeathers()

    useEffect(() => {
      feathersFromHook = feathers
    }, [feathers])

    return null
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Content />
    </App>,
  )

  await flush()

  t.is(feathersFromHook, feathers)

  unmount()
})

test('Provider requires feathers to be passed in', async t => {
  const { render, flush, unmount, $ } = dom()

  function Content() {
    return null
  }

  swallowErrors(() => {
    render(
      <App config={{ idField: '_xid' }}>
        <Content />
      </App>,
    )
  })

  await flush()

  t.is($('.error').innerHTML, 'Please pass in a feathers client')

  unmount()
})

test('support _id out of the box', async t => {
  const { render, flush, unmount, $ } = dom()
  const feathers = mockFeathers({
    notes: {
      data: {
        1: {
          _id: 1,
          content: 'hello _id',
        },
      },
    },
  })

  function Note() {
    const notes = useFind('notes')
    return <NoteList notes={notes} keyField='_id' />
  }

  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.note').innerHTML, 'hello _id')

  unmount()
})

test('support custom idField string', async t => {
  const { render, flush, unmount, $ } = dom()
  const feathers = mockFeathers({
    notes: {
      data: {
        1: {
          _xid: 1,
          content: 'hello _xid',
        },
      },
    },
  })

  function Note() {
    const notes = useFind('notes')
    return <NoteList notes={notes} keyField='_xid' />
  }

  render(
    <App feathers={feathers} config={{ idField: '_xid' }}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.note').innerHTML, 'hello _xid')

  unmount()
})

test('support custom idField function', async t => {
  const { render, flush, unmount, $ } = dom()
  const feathers = mockFeathers({
    notes: {
      data: {
        1: {
          _foo: 1,
          content: 'hello _foo',
        },
      },
    },
  })

  function Note() {
    const notes = useFind('notes')
    return <NoteList notes={notes} keyField='_foo' />
  }

  render(
    <App feathers={feathers} config={{ idField: entity => entity._foo }}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.note').innerHTML, 'hello _foo')

  unmount()
})

test('useFind error', async t => {
  const { render, flush, unmount, $ } = dom()

  function Note() {
    const notes = useFind('notes')
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  feathers.service('notes').find = () => {
    return Promise.reject(new Error('unexpected'))
  }
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.error').innerHTML, 'unexpected')

  unmount()
})

test('useFind with skip', async t => {
  const { render, flush, unmount, $ } = dom()

  function Note() {
    const notes = useFind('notes', {
      skip: true,
    })
    return <div className='data'>{notes.data ? 'yes' : 'no'}</div>
  }

  const feathers = createFeathers()
  feathers.service('notes').find = () => {
    throw new Error('Should not be called')
  }
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.data').innerHTML, 'no')

  unmount()
})

test('useFind with refetch', async t => {
  const { render, flush, unmount, $ } = dom()
  let refetch

  function Note() {
    const notes = useFind('notes')

    refetch = notes.refetch

    return <div className='data'>{notes.data && notes.data[0].id}</div>
  }

  const results = [{ data: [{ id: 1 }] }, { data: [{ id: 2 }] }]
  const feathers = createFeathers()

  let calls = 0
  feathers.service('notes').find = () => {
    calls++
    const res = results.shift()
    return Promise.resolve(res)
  }

  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.data').innerHTML, '1')

  await flush(() => {
    refetch()
  })

  t.is($('.data').innerHTML, '2')

  unmount()

  t.is(calls, 2)
})

test('useFind with allPages', async t => {
  const { render, flush, unmount, $all } = dom()
  function Note() {
    const notes = useFind('notes', { query: { $limit: 1 }, allPages: true })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()

  await feathers.service('notes').create({ id: 2, content: 'doc', tag: 'idea' })
  await feathers.service('notes').create({ id: 3, content: 'dmc', tag: 'unrelated' })

  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello', 'doc', 'dmc'],
  )

  unmount()
})

test('useFind with allPages and parallel', async t => {
  const { render, flush, unmount, $all } = dom()
  function Note() {
    const notes = useFind('notes', { query: { $limit: 2 }, allPages: true, parallel: true })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()

  await feathers.service('notes').create({ id: 2, content: 'doc', tag: 'idea' })
  await feathers.service('notes').create({ id: 3, content: 'dmc', tag: 'unrelated' })

  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello', 'doc', 'dmc'],
  )
  t.is(feathers.service('notes').counts.find, 2)

  unmount()
})

test('useFind with allPages and parallel where limit is not wholly divisible by total', async t => {
  const { render, flush, unmount, $all } = dom()

  function Note() {
    const notes = useFind('notes', { query: { $limit: 2 }, allPages: true, parallel: true })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()

  await flush(async () => {
    await feathers.service('notes').create({ id: 2, content: 'doc', tag: 'idea' })
    await feathers.service('notes').create({ id: 3, content: 'dmc', tag: 'unrelated' })
    await feathers.service('notes').create({ id: 4, content: 'wat', tag: 'nonsense' })
    await feathers.service('notes').create({ id: 5, content: 'huh', tag: 'thingies' })
  })

  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello', 'doc', 'dmc', 'wat', 'huh'],
  )
  t.is(feathers.service('notes').counts.find, 3) // first call returns initial 2, second returns 3 and 4, third returns 5

  unmount()
})

test('useFind - realtime merge', async t => {
  const { render, flush, unmount, $all } = dom()

  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' }, realtime: 'merge' })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello'],
  )

  await flush(async () => {
    await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })
  })

  // no find happened in the backround!
  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['doc'],
  )

  unmount()
})

test('useFind - realtime refetch', async t => {
  const { render, flush, unmount, $all } = dom()
  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' }, realtime: 'refetch' })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello'],
  )

  await flush(async () => {
    await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })
  })

  // another find happened in the backround!
  t.is(feathers.service('notes').counts.find, 2)

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['doc'],
  )

  unmount()
})

test('useFind - realtime disabled', async t => {
  const { render, flush, unmount, $all } = dom()
  let notes

  function Note() {
    const _notes = useFind('notes', { query: { tag: 'idea' }, realtime: 'disabled' })

    useEffect(() => {
      notes = _notes
    })

    return <NoteList notes={_notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello'],
  )

  await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })

  await flush()

  // no find happened in the backround!
  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello'],
  )

  await flush(() => {
    notes.refetch()
  })

  // another find happened in the backround!
  t.is(feathers.service('notes').counts.find, 2)

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['doc'],
  )

  unmount()
})

test('useFind - fetchPolicy swr', async t => {
  const { render, flush, unmount, $all } = dom()
  let renderNote

  function Content() {
    const [shouldRenderNote, setRenderNote] = useState(true)
    renderNote = setRenderNote
    return shouldRenderNote ? <Note /> : null
  }

  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' }, fetchPolicy: 'swr' })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Content />
    </App>,
  )

  await flush()

  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello'],
  )

  await flush(() => {
    renderNote(false)
  })

  // update note in the meantime
  await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })

  feathers.service('notes').setDelay(30)

  // render 2nd time
  await flush(() => {
    renderNote(true)
  })

  // a 2nd find happened in the background
  t.is(feathers.service('notes').counts.find, 2)

  // but we see old note at first
  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello'],
  )

  // and then after a while
  await flush()
  await flush()

  // we see new note
  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['doc'],
  )

  feathers.service('notes').setDelay(0)

  unmount()
})

test('useFind - fetchPolicy cache-first', async t => {
  const { render, flush, unmount, $all } = dom()
  let renderNote

  function Content() {
    const [shouldRenderNote, setRenderNote] = useState(true)
    renderNote = setRenderNote
    return shouldRenderNote ? <Note /> : null
  }

  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' }, fetchPolicy: 'cache-first' })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Content />
    </App>,
  )

  await flush()

  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello'],
  )

  await flush(() => {
    renderNote(false)
  })

  // update note in the meantime
  await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })

  // render 2nd time
  await flush(() => {
    renderNote(true)
  })

  // no find happened this time, we used cache!
  t.is(feathers.service('notes').counts.find, 1)

  // we see old note
  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello'],
  )

  unmount()
})

test('useFind - fetchPolicy network-only', async t => {
  const { render, flush, unmount, $all } = dom()
  let renderNote

  function Content() {
    const [shouldRenderNote, setRenderNote] = useState(true)
    renderNote = setRenderNote
    return shouldRenderNote ? <Note /> : null
  }

  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' }, fetchPolicy: 'network-only' })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Content />
    </App>,
  )

  await flush()

  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello'],
  )

  await flush(() => {
    renderNote(false)
  })

  // update note in the meantime
  await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })

  feathers.service('notes').setDelay(30)

  // render 2nd time
  await flush(() => {
    renderNote(true)
  })

  // a 2nd find happened in the background
  t.is(feathers.service('notes').counts.find, 2)

  // we see no notes since we're still fetching
  // cache was not used
  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    [],
  )

  // and then after a while
  await flush()
  await flush()

  // we see new note
  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['doc'],
  )

  feathers.service('notes').setDelay(0)

  unmount()
})

test('useFind - updates correctly after a sequence of create+patch', async t => {
  const { render, flush, unmount, $, $all } = dom()
  function Note() {
    const notes = useFind('notes')
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.note').innerHTML, 'hello')

  await flush(async () => {
    await feathers.service('notes').create({ id: 2, content: 'doc' })
    await feathers.service('notes').patch(2, { content: 'doc updated' })
  })

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello', 'doc updated'],
  )

  unmount()
})

test('useFind - with custom matcher', async t => {
  const { render, flush, unmount, $, $all } = dom()
  const customMatcher = matcher => query => item => {
    return matcher(query)(item) && item.foo
  }

  function Note() {
    const notes = useFind('notes', { query: { tag: 'post' }, matcher: customMatcher })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.note').innerHTML, 'hello')

  await flush(async () => {
    await feathers.service('notes').create({ id: 2, tag: 'post', content: 'doc 2', foo: false })
    await feathers.service('notes').create({ id: 3, tag: 'post', content: 'doc 3', foo: true })
    await feathers.service('notes').create({ id: 4, tag: 'draft', content: 'doc 4', foo: true })
  })

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello', 'doc 3'],
  )

  await flush(async () => {
    await feathers.service('notes').patch(4, { tag: 'post' })
  })

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello', 'doc 3', 'doc 4'],
  )

  unmount()
})

test('item gets deleted from cache if it is updated and no longer relevant to a query', async t => {
  const { render, flush, unmount, $, $all } = dom()
  const feathers = createFeathers()
  const store = createStore()

  function Note() {
    const notes = useFind('notes', { query: { tag: 'post' } })
    return <NoteList notes={notes} />
  }

  render(
    <App feathers={feathers} store={store} config={{ noUpdatedAt: true }}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.note').innerHTML, 'hello')

  await flush(async () => {
    await feathers.service('notes').patch(1, { updatedAt: null })
    await feathers.service('notes').patch(1, { tag: 'post', content: 'doc 1', updatedAt: 1 })
    await feathers.service('notes').create({ id: 2, tag: 'post', content: 'doc 2', updatedAt: 2 })
    await feathers.service('notes').create({ id: 3, tag: 'post', content: 'doc 3', updatedAt: 3 })
  })

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['doc 1', 'doc 2', 'doc 3'],
  )

  t.deepEqual(store.debug().figbird.entities, {
    notes: {
      1: {
        id: 1,
        tag: 'post',
        content: 'doc 1',
        updatedAt: 1,
      },
      2: {
        id: 2,
        tag: 'post',
        content: 'doc 2',
        updatedAt: 2,
      },
      3: {
        id: 3,
        tag: 'post',
        content: 'doc 3',
        updatedAt: 3,
      },
    },
  })

  t.deepEqual(store.debug().figbird.index, {
    notes: {
      1: {
        queries: {
          'f:-1755522248': true,
        },
        size: 1,
      },
      2: {
        queries: {
          'f:-1755522248': true,
        },
        size: 1,
      },
      3: {
        queries: {
          'f:-1755522248': true,
        },
        size: 1,
      },
    },
  })

  await flush(async () => {
    await feathers.service('notes').patch(3, { tag: 'draft' })
  })

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['doc 1', 'doc 2'],
  )

  t.deepEqual(store.debug().figbird.entities, {
    notes: {
      1: {
        id: 1,
        tag: 'post',
        content: 'doc 1',
        updatedAt: 1,
      },
      2: {
        id: 2,
        tag: 'post',
        content: 'doc 2',
        updatedAt: 2,
      },
    },
  })

  t.deepEqual(store.debug().figbird.index, {
    notes: {
      1: {
        queries: {
          'f:-1755522248': true,
        },
        size: 1,
      },
      2: {
        queries: {
          'f:-1755522248': true,
        },
        size: 1,
      },
    },
  })

  unmount()
})
