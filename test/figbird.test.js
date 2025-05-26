import React, { useState, useEffect, StrictMode } from 'react'
import test from 'ava'
import { dom, mockFeathers } from './helpers'
import {
  Figbird,
  Provider,
  FeathersAdapter,
  useGet,
  useFind,
  useMutation,
  useFeathers,
} from '../lib'

const createFeathers = ({ skipTotal } = {}) =>
  mockFeathers({
    skipTotal,
    notes: {
      data: {
        1: {
          id: 1,
          content: 'hello',
          updatedAt: new Date('2024-02-02').getTime(),
        },
      },
    },
  })

function App({ feathers, figbird, config, children }) {
  const adapter = new FeathersAdapter(feathers, config)
  figbird = figbird || new Figbird({ adapter })
  return (
    <StrictMode>
      <ErrorHandler>
        <Provider figbird={figbird}>{children}</Provider>
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

  // Handle cases where data is null (e.g., when skip:true and status is 'idle')
  if (!notes.data) {
    return null
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

  let noteData

  function Note() {
    const note = useGet('notes', 1)
    noteData = note.data
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
  t.is(noteData.id, 1, 'useGet returns an object, not an array')

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
  const { render, flush, unmount, $ } = dom()
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

  t.is($('.note').innerHTML, 'doc')

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

test('realtime listeners continue updating the store even if queries are unmounted', async t => {
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
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter })

  render(
    <App feathers={feathers} figbird={figbird}>
      <Notes />
    </App>,
  )

  await flush()

  t.is($('.note2').innerHTML, 'hello')
  t.is(figbird.getState().get('notes').entities.get(1).content, 'hello')

  await flush(async () => {
    await feathers.service('notes').patch(1, { content: 'real' })
  })
  t.is(figbird.getState().get('notes').entities.get(1).content, 'real')

  t.deepEqual(
    $all('.note2').map(n => n.innerHTML),
    ['real'],
  )

  unmount()

  await flush(async () => {
    await feathers.service('notes').patch(1, { content: 'still updating' })
  })

  // should have updated
  t.is(figbird.getState().get('notes').entities.get(1).content, 'still updating')
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

  await flush(async () => {
    await create([
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
  let _patch

  function Note() {
    const note = useGet('notes', 1)
    const { patch } = useMutation('notes')
    _patch = patch
    return <NoteList notes={note} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush(async () => {
    await _patch(1, { content: 'hi1' })
  })
  t.is($('.note').innerHTML, 'hi1')

  await flush(async () => {
    await _patch(1, { content: 'hi2' })
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
  const { render, unmount } = dom()

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

  t.is(feathersFromHook, feathers)

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

  let setSkip

  function Note() {
    const [skip, _setSkip] = useState(true)
    setSkip = _setSkip
    const notes = useFind('notes', { skip })
    return <div className='data'>{notes.status}</div>
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  t.is($('.data').innerHTML, 'idle')
  t.is(feathers.service('notes').counts.find, 0, 'No find() calls when skip=true')

  await flush(() => {
    setSkip(false)
  })

  t.is($('.data').innerHTML, 'success')
  t.is(feathers.service('notes').counts.find, 1, 'One find() call when skip=false')

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

test('useFind with refetch while already fetching', async t => {
  const { render, flush, unmount, $ } = dom()
  let refetch

  function Note() {
    const notes = useFind('notes')
    refetch = notes.refetch
    return <div className='data'>{notes.data && notes.data[0].id}</div>
  }

  const results = [{ data: [{ id: 1 }] }, { data: [{ id: 2 }] }, { data: [{ id: 3 }] }]
  const feathers = createFeathers()

  let calls = 0
  feathers.service('notes').find = () => {
    calls++
    const res = results.shift()
    if (calls === 1) {
      // First call is slow
      return new Promise(resolve => setTimeout(() => resolve(res), 20))
    }
    // Subsequent calls are fast
    return Promise.resolve(res)
  }

  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  // Wait a bit to ensure first fetch has started
  await new Promise(resolve => setTimeout(resolve, 5))

  t.is(calls, 1, 'First fetch should have started')

  // Call refetch while the first fetch is still in progress
  refetch()

  // Wait for both fetches to complete
  await flush(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

  t.is(calls, 2, 'Should have fetched twice')
  t.is($('.data').innerHTML, '2', 'Should show result from second fetch')

  // Call refetch again after everything is done
  await flush(() => {
    refetch()
  })

  t.is(calls, 3, 'Should have fetched a third time')
  t.is($('.data').innerHTML, '3', 'Should show result from third fetch')

  unmount()
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

test('useFind with allPages without total', async t => {
  const { render, flush, unmount, $all } = dom()
  function Note() {
    const notes = useFind('notes', { query: { $limit: 1 }, allPages: true })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers({ skipTotal: true })

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

  await feathers.service('notes').create({ id: 2, content: 'doc', tag: 'idea' })
  await feathers.service('notes').create({ id: 3, content: 'dmc', tag: 'unrelated' })
  await feathers.service('notes').create({ id: 4, content: 'wat', tag: 'nonsense' })
  await feathers.service('notes').create({ id: 5, content: 'huh', tag: 'thingies' })

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

test('useFind with allPages and defaultPageSize', async t => {
  const { render, flush, unmount, $all } = dom()
  function Note() {
    const notes = useFind('notes', { allPages: true })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()

  await feathers.service('notes').create({ id: 2, content: 'doc', tag: 'idea' })
  await feathers.service('notes').create({ id: 3, content: 'dmc', tag: 'unrelated' })

  t.is(feathers.service('notes').counts.find, 0)

  render(
    <App feathers={feathers} config={{ defaultPageSize: 1 }}>
      <Note />
    </App>,
  )

  await flush()

  t.is(feathers.service('notes').counts.find, 3)

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello', 'doc', 'dmc'],
  )

  unmount()
})

test('useFind with allPages and defaultPageSizeWhenFetchingAll', async t => {
  const { render, flush, unmount, $all } = dom()
  function Note() {
    const notes = useFind('notes', { allPages: true })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()

  await feathers.service('notes').create({ id: 2, content: 'doc', tag: 'idea' })
  await feathers.service('notes').create({ id: 3, content: 'dmc', tag: 'unrelated' })

  t.is(feathers.service('notes').counts.find, 0)

  render(
    <App feathers={feathers} config={{ defaultPageSizeWhenFetchingAll: 1 }}>
      <Note />
    </App>,
  )

  await flush()

  t.is(feathers.service('notes').counts.find, 3)

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello', 'doc', 'dmc'],
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
  await flush(async () => {
    await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })
  })

  feathers.service('notes').setDelay(10)

  // render 2nd time
  await flush(() => {
    renderNote(true)
  })

  // a 2nd find happened in the background
  t.is(feathers.service('notes').counts.find, 2)

  // but we see old note at first - TODO - we don't,
  // because we now always incorporate realtime events into the cache
  // even if the components are unmounted!
  // t.deepEqual(
  //   $all('.note').map(n => n.innerHTML),
  //   ['hello'],
  // )

  // and then after a while
  await flush(async () => {
    await new Promise(resolve => setTimeout(resolve, 10))
  })

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

  // we see new, patched note!
  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['doc'],
  )

  unmount()
})

test('useFind - fetchPolicy cache-first and changing query', async t => {
  const { render, flush, unmount, $all } = dom()
  let renderNote

  function Content() {
    const [n, setRenderNote] = useState(1)
    renderNote = setRenderNote
    return n ? <Note n={n} /> : null
  }

  function Note({ n }) {
    const notes = useFind('notes', { query: { tag: 'idea' }, n, fetchPolicy: 'cache-first' })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter })
  render(
    <App feathers={feathers} figbird={figbird}>
      <Content />
    </App>,
  )

  await flush()

  // fetched once and got the default hello note
  t.is(feathers.service('notes').counts.find, 1)
  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello'],
  )

  // unrender!
  await flush(() => {
    renderNote(0)
  })

  // update note 1 in the meantime
  await flush(async () => {
    await feathers.service('notes').patch(1, { content: 'hello-2', superduper: true, tag: 'idea' })
  })

  // render 2nd time
  await flush(() => {
    renderNote(2)
  })

  // we did a second find because we changed n param to 2
  t.is(feathers.service('notes').counts.find, 2)
  // we see the updated note
  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello-2'],
  )

  // render with n=1 again, we want to hit cache here!
  await flush(() => {
    renderNote(1)
  })

  // no find happened this time, we used cache, even though we changed n!
  t.is(feathers.service('notes').counts.find, 2)
  // we see the new note due to cache sharing
  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['hello-2'],
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
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter })
  render(
    <App feathers={feathers} figbird={figbird}>
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
  await flush(async () => {
    await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })
  })

  feathers.service('notes').setDelay(10)

  // render 2nd time
  await flush(() => {
    renderNote(true)
  })

  // a 2nd find happened in the background
  t.is(feathers.service('notes').counts.find, 3) // re-mounting in <StrictMode /> double subscribes

  // we see no notes since we're still fetching
  // cache was not used
  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    [],
  )

  // and then after a while
  await flush(async () => {
    await new Promise(resolve => setTimeout(resolve, 10))
  })

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
  const { matcher: defaultMatcher } = await import('../lib/adapters/matcher')
  const customMatcher = query => item => {
    const match = defaultMatcher(query)
    return match(item) && item.foo
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

test('items get updated in cache even if not currently relevant to any query', async t => {
  const { render, flush, unmount, $, $all } = dom()
  const feathers = createFeathers()
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter })

  function Note() {
    const notes = useFind('notes', { query: { tag: 'post' } })
    return <NoteList notes={notes} />
  }

  render(
    <App feathers={feathers} figbird={figbird} config={{ noUpdatedAt: true }}>
      <Note />
    </App>,
  )

  await flush()

  t.is($('.note').innerHTML, 'hello')

  await flush(async () => {
    await feathers.service('notes').patch(1, { updatedAt: null })
  })

  const t1 = Date.now()
  await flush(async () => {
    await feathers.service('notes').patch(1, { tag: 'post', content: 'doc 1', updatedAt: t1 })
    await feathers.service('notes').create({ id: 2, tag: 'post', content: 'doc 2', updatedAt: 2 })
    await feathers.service('notes').create({ id: 3, tag: 'post', content: 'doc 3', updatedAt: 3 })
  })

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['doc 1', 'doc 2', 'doc 3'],
  )

  t.deepEqual(serialize(figbird.getState().get('notes').entities), {
    1: {
      id: 1,
      tag: 'post',
      content: 'doc 1',
      updatedAt: t1,
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
  })

  t.deepEqual(serialize(figbird.getState().get('notes').itemQueryIndex), {
    1: ['q/BTSlpA=='],
    2: ['q/BTSlpA=='],
    3: ['q/BTSlpA=='],
  })

  await flush(async () => {
    await feathers.service('notes').patch(3, { tag: 'draft', updatedAt: 4 })
  })

  t.deepEqual(
    $all('.note').map(n => n.innerHTML),
    ['doc 1', 'doc 2'],
  )

  t.deepEqual(serialize(figbird.getState().get('notes').entities), {
    1: {
      id: 1,
      tag: 'post',
      content: 'doc 1',
      updatedAt: t1,
    },
    2: {
      id: 2,
      tag: 'post',
      content: 'doc 2',
      updatedAt: 2,
    },
    3: {
      id: 3,
      tag: 'draft',
      content: 'doc 3',
      updatedAt: 4,
    },
  })

  t.deepEqual(serialize(figbird.getState().get('notes').itemQueryIndex), {
    1: ['q/BTSlpA=='],
    2: ['q/BTSlpA=='],
    3: [],
  })

  unmount()
})

test('useFind - state sequencing for fetchPolicy swr', async t => {
  const { render, flush, unmount } = dom()

  let seq = []

  let renderNote

  function Note() {
    const [n, setN] = useState(1)
    renderNote = setN

    const notes = useFind('notes', { n })

    const { data, status, isFetching } = notes
    useEffect(() => {
      seq.push({ data, status, isFetching })
    }, [data, status, isFetching])

    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Note />
    </App>,
  )

  await flush()

  t.deepEqual(seq, [
    { data: null, isFetching: true, status: 'loading' },
    {
      data: [{ content: 'hello', id: 1, updatedAt: 1706832000000 }],
      isFetching: false,
      status: 'success',
    },
  ])

  seq = []

  // change params
  await flush(() => {
    renderNote(2)
  })

  t.deepEqual(seq, [
    { data: null, isFetching: true, status: 'loading' },
    {
      data: [{ content: 'hello', id: 1, updatedAt: 1706832000000 }],
      isFetching: false,
      status: 'success',
    },
  ])

  unmount()
})

test('useFind - state sequencing for fetchPolicy network-only', async t => {
  const { render, flush, unmount } = dom()

  let seq = []

  let renderNote

  function Content() {
    const [n, setRenderNote] = useState(1)
    renderNote = setRenderNote
    return n ? <Note n={n} /> : null
  }

  function Note({ n }) {
    const notes = useFind('notes', { query: { tag: 'idea', n }, fetchPolicy: 'network-only' })

    const { data, status, isFetching } = notes
    useEffect(() => {
      seq.push({ data, status, isFetching })
    }, [data, status, isFetching])

    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Content />
    </App>,
  )

  await flush()

  t.deepEqual(seq, [
    { data: null, isFetching: true, status: 'loading' },
    {
      data: [{ content: 'hello', id: 1, updatedAt: 1706832000000 }],
      isFetching: false,
      status: 'success',
    },
  ])

  seq = []

  await flush(() => {
    renderNote(2)
  })

  t.deepEqual(seq, [
    { data: null, isFetching: true, status: 'loading' },
    {
      data: [{ content: 'hello', id: 1, updatedAt: 1706832000000 }],
      isFetching: false,
      status: 'success',
    },
  ])

  unmount()
})

test('subscribeToStateChanges', async t => {
  const { render, flush, unmount } = dom()

  function Note() {
    const notes = useFind('notes', { query: { tag: 'post' } })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const adapter = new FeathersAdapter(feathers)
  const figbird = new Figbird({ adapter })

  render(
    <App feathers={feathers} figbird={figbird}>
      <Note />
    </App>,
  )

  await flush()

  let state
  const unsub = figbird.subscribeToStateChanges(s => {
    state = JSON.parse(JSON.stringify(serialize(s)))
    // Remove updatedAt fields from all entities
    Object.values(state.notes.entities).forEach(entity => {
      delete entity.updatedAt
    })
    // Remove updatedAt fields from all query data
    Object.values(state.notes.queries).forEach(query => {
      const data = query.state.data
      if (Array.isArray(data)) {
        data.forEach(item => delete item.updatedAt)
      } else if (data && typeof data === 'object') {
        delete data.updatedAt
      }
    })
  })

  await flush(async () => {
    await feathers.service('notes').create({ id: 2, tag: 'post', content: 'doc 2' })
    await feathers.service('notes').patch(2, { content: 'doc 2 updated' })
  })

  t.snapshot(state)

  unsub()

  unmount()
})

test('useFind - multiple queries against the same service', async t => {
  const { render, flush, unmount, $all } = dom()

  function NoteList1() {
    const notes = useFind('notes', { query: { tag: 'post' } })
    return (
      <div className='list1'>
        <NoteList notes={notes} />
      </div>
    )
  }

  function NoteList2() {
    const notes = useFind('notes', { query: { tag: 'draft' } })
    return (
      <div className='list2'>
        <NoteList notes={notes} />
      </div>
    )
  }

  function Lists() {
    return (
      <>
        <NoteList1 />
        <NoteList2 />
      </>
    )
  }

  const feathers = createFeathers()
  render(
    <App feathers={feathers}>
      <Lists />
    </App>,
  )

  await flush()

  t.deepEqual(
    $all('.list1 .note').map(n => n.innerHTML),
    ['hello'],
  )

  t.deepEqual(
    $all('.list2 .note').map(n => n.innerHTML),
    ['hello'],
  )

  await flush(async () => {
    await feathers.service('notes').create({ id: 2, tag: 'post', content: 'post note' })
    await feathers.service('notes').create({ id: 3, tag: 'draft', content: 'draft note' })
  })

  t.deepEqual(
    $all('.list1 .note').map(n => n.innerHTML),
    ['hello', 'post note'],
  )

  t.deepEqual(
    $all('.list2 .note').map(n => n.innerHTML),
    ['hello', 'draft note'],
  )

  unmount()
})

test('useFind - stale realtime event is ignored', async t => {
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

  // Patch with old timestamp
  await flush(async () => {
    await feathers.service('notes').patch(1, {
      content: 'old update',
      updatedAt: new Date('2024-01-01').getTime(),
    })
  })

  // Old update should be ignored
  t.is($('.note').innerHTML, 'hello')

  // Patch with newer timestamp
  await flush(async () => {
    await feathers.service('notes').patch(1, {
      content: 'new update',
      updatedAt: new Date('2024-03-01').getTime(),
    })
  })

  // New update should be applied
  t.is($('.note').innerHTML, 'new update')

  unmount()
})

test('recursive serializer for maps and sets', async t => {
  t.deepEqual(
    serialize(
      new Map([
        ['a', 1],
        ['b', new Set([1, 2, 3])],
        ['c', new Map([['d', 4]])],
      ]),
    ),
    {
      a: 1,
      b: [1, 2, 3],
      c: { d: 4 },
    },
  )
})

test('useFind handles rapid query parameter changes without showing stale data', async t => {
  const { render, flush, unmount, $ } = dom()
  let setTag

  function SearchableNotes() {
    const [tag, _setTag] = useState('')
    setTag = _setTag

    const notes = useFind('notes', {
      query: { tag },
      skip: !tag,
    })

    return (
      <div>
        <div className='status'>{notes.status}</div>
        <div className='fetching'>{notes.isFetching ? 'true' : 'false'}</div>
        {notes.data && <div className='count'>{notes.data.length}</div>}
        <NoteList notes={notes} />
      </div>
    )
  }

  const feathers = createFeathers()

  // Add more test data
  await feathers.service('notes').create({ id: 2, content: 'javascript tutorial', tag: 'slow' })
  await feathers.service('notes').create({ id: 3, content: 'react hooks guide', tag: 'react' })
  await feathers.service('notes').create({ id: 4, content: 'nodejs basics', tag: 'node' })

  // Mock delays based on tag
  const originalFind = feathers.service('notes').find.bind(feathers.service('notes'))
  let findCallCount = 0
  feathers.service('notes').find = async params => {
    findCallCount++
    const tag = params.query?.tag
    if (tag === 'slow') {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const result = await originalFind(params)
    // Filter by tag if provided
    if (tag) {
      result.data = result.data.filter(item => item.tag === tag)
      result.total = result.data.length
    }
    return result
  }

  render(
    <App feathers={feathers}>
      <SearchableNotes />
    </App>,
  )

  t.is($('.status').innerHTML, 'idle')

  // Rapid changes: slow query followed by fast query
  await flush(() => {
    setTag('slow') // This will take 50ms
  })

  // Immediately change to a faster query
  await flush(() => {
    setTag('react') // This should complete faster
  })

  // Wait for all queries to settle
  await flush(async () => {
    await new Promise(resolve => setTimeout(resolve, 100))
  })

  // Should show results for 'react', not 'slow'
  t.is($('.count').innerHTML, '1')
  t.is($('.note').innerHTML, 'react hooks guide')

  // At least 2 queries should have been initiated (might be more due to StrictMode)
  t.true(findCallCount >= 2, `Expected at least 2 find calls, got ${findCallCount}`)

  unmount()
})

test('useFind recovers gracefully from errors on refetch', async t => {
  const { render, flush, unmount, $ } = dom()
  let refetch
  let failCount = 0

  function Notes() {
    const notes = useFind('notes')
    refetch = notes.refetch

    return (
      <div>
        <div className='status'>{notes.status}</div>
        <div className='fetching'>{notes.isFetching ? 'true' : 'false'}</div>
        {notes.error && <div className='error'>{notes.error.message}</div>}
        <NoteList notes={notes} />
      </div>
    )
  }

  const feathers = createFeathers()

  // Make the service fail first 2 times, then succeed
  const originalFind = feathers.service('notes').find.bind(feathers.service('notes'))
  feathers.service('notes').find = async params => {
    failCount++
    if (failCount <= 2) {
      throw new Error('Network error')
    }
    return originalFind(params)
  }

  render(
    <App feathers={feathers}>
      <Notes />
    </App>,
  )

  // Initial load fails
  await flush()
  t.is($('.status').innerHTML, 'error')
  t.is($('.error').innerHTML, 'Network error')
  t.is($('.fetching').innerHTML, 'false')

  // First retry fails
  await flush(() => {
    refetch()
  })

  t.is($('.status').innerHTML, 'error')
  t.is($('.fetching').innerHTML, 'false')

  // Second retry succeeds
  await flush(() => {
    refetch()
  })

  t.is($('.status').innerHTML, 'success')
  t.is($('.note').innerHTML, 'hello')
  t.is($('.fetching').innerHTML, 'false')

  unmount()
})

test('concurrent mutations maintain data consistency', async t => {
  const { render, flush, unmount, $all } = dom()
  let hasFiredMutations = false

  const feathers = createFeathers()

  // Add delays to simulate network latency
  const originalPatch = feathers.service('notes').patch.bind(feathers.service('notes'))
  feathers.service('notes').patch = async (id, data) => {
    if (data.content === 'update1') {
      await new Promise(resolve => setTimeout(resolve, 30))
    } else if (data.content === 'update2') {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return originalPatch(id, data)
  }

  function Notes() {
    const notes = useFind('notes')
    const { patch: patch1 } = useMutation('notes')
    const { patch: patch2 } = useMutation('notes')

    React.useEffect(() => {
      if (notes.data && notes.data.length > 0 && !hasFiredMutations) {
        hasFiredMutations = true
        // Fire two mutations concurrently on the same item
        const id = notes.data[0].id

        // Fire both mutations
        patch1(id, { content: 'update1', version: 1 })
        patch2(id, { content: 'update2', version: 2 })
      }
    }, [notes.data, patch1, patch2])

    return <NoteList notes={notes} />
  }

  render(
    <App feathers={feathers}>
      <Notes />
    </App>,
  )

  // Wait for both mutations to complete
  await flush(async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
  })

  // The last update to complete should win (update1 because it has longer delay)
  t.is($all('.note').length, 1)
  t.is($all('.note')[0].innerHTML, 'update1')

  unmount()
})

test('handles component unmounting during active requests without warnings', async t => {
  const { render, flush, unmount } = dom()
  let unmountNotes
  const warnings = []

  // Capture console warnings
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))

  function Container() {
    const [showNotes, setShowNotes] = useState(true)
    unmountNotes = () => setShowNotes(false)

    return showNotes ? <Notes /> : <div>Unmounted</div>
  }

  function Notes() {
    const notes = useFind('notes')
    const { create } = useMutation('notes')

    React.useEffect(() => {
      // Start a mutation that will complete after component unmounts
      create({ id: 999, content: 'created after unmount' })
    }, [create])

    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()

  // Add delay to create to ensure it completes after unmount
  const originalCreate = feathers.service('notes').create.bind(feathers.service('notes'))
  feathers.service('notes').create = async data => {
    await new Promise(resolve => setTimeout(resolve, 20))
    return originalCreate(data)
  }

  render(
    <App feathers={feathers}>
      <Container />
    </App>,
  )

  // Let the effect run and start the mutation
  await flush()

  // Unmount while mutation is in flight
  await flush(() => {
    unmountNotes()
  })

  // Wait for mutation to complete
  await flush(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

  // Restore console.warn
  console.warn = originalWarn

  // Should not have any warnings about updating unmounted components
  const reactWarnings = warnings.filter(
    w => w.includes('unmounted component') || w.includes("Can't perform a React state update"),
  )
  t.is(reactWarnings.length, 0, 'No React unmount warnings')

  unmount()
})

test('allPages handles errors gracefully during pagination', async t => {
  const { render, flush, unmount, $ } = dom()

  function Notes() {
    const notes = useFind('notes', {
      query: { $limit: 2 },
      allPages: true,
    })

    return (
      <div>
        <div className='status'>{notes.status}</div>
        {notes.error && <div className='error'>{notes.error.message}</div>}
        <div className='count'>{notes.data ? notes.data.length : 0}</div>
      </div>
    )
  }

  const feathers = createFeathers()

  // Add more data
  await feathers.service('notes').create({ id: 2, content: 'note2' })
  await feathers.service('notes').create({ id: 3, content: 'note3' })
  await feathers.service('notes').create({ id: 4, content: 'note4' })
  await feathers.service('notes').create({ id: 5, content: 'note5' })

  // Make the third page fail
  let callCount = 0
  const originalFind = feathers.service('notes').find.bind(feathers.service('notes'))
  feathers.service('notes').find = async params => {
    callCount++
    if (callCount === 3) {
      // Third page
      throw new Error('Network error on page 3')
    }
    return originalFind(params)
  }

  render(
    <App feathers={feathers}>
      <Notes />
    </App>,
  )

  await flush()

  // Should show error status
  t.is($('.status').innerHTML, 'error')
  t.is($('.error').innerHTML, 'Network error on page 3')
  // Should not have any partial data
  t.is($('.count').innerHTML, '0')

  unmount()
})

function serialize(input) {
  if (input instanceof Map) {
    const obj = {}
    for (const [key, value] of input) {
      obj[key] = serialize(value)
    }
    return obj
  } else if (input instanceof Set) {
    return Array.from(input).map(serialize)
  } else if (Array.isArray(input)) {
    return input.map(serialize)
  } else if (input && typeof input === 'object') {
    const obj = {}
    for (const [key, value] of Object.entries(input)) {
      obj[key] = serialize(value)
    }
    return obj
  }
  return input
}
