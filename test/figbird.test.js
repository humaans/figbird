import React, { useState, useEffect } from 'react'
import { mount as mountToDOM } from 'enzyme'
import test from 'ava'
import { mockFeathers, flush } from './helpers'
import { Provider, useFigbird, useGet, useFind, useMutation, useFeathers } from '../lib'

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

function App({ feathers, config, children }) {
  function AtomObserver({ children }) {
    const { atom } = useFigbird()
    useEffect(() => {
      return atom.observe(atom => {})
    }, [])
    return children
  }
  return (
    <TestErrorHandler>
      <Provider feathers={feathers} {...config}>
        <AtomObserver>{children}</AtomObserver>
      </Provider>
    </TestErrorHandler>
  )
}

class TestErrorHandler extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error: error.message }
  }

  componentDidCatch(error) {
    if (error.message === 'Please pass in a feathers client') return
    console.error('Failed to render', error)
  }

  render() {
    if (this.state.hasError) return <div className='error'>{this.state.error}</div>
    return this.props.children
  }
}

function mount(Comp, feathers, config) {
  return mountToDOM(
    <App feathers={feathers} config={config}>
      <Comp />
    </App>
  )
}

function NoteList({ notes, keyField = 'id' }) {
  if (notes.error) {
    return <div className='error'>{notes.error.message}</div>
  }

  if (notes.loading) {
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
  function Note() {
    const note = useGet('notes', 1)
    return <NoteList notes={note} />
  }

  const app = mount(Note, createFeathers())

  t.is(app.find('.spinner').text(), 'loading...')

  await flush(app)

  t.is(app.find('.note').text(), 'hello')

  app.unmount()
})

test('useGet updates after realtime patch', async t => {
  function Note() {
    const note = useGet('notes', 1)
    return <NoteList notes={note} />
  }

  const feathers = createFeathers()
  const app = mount(Note, feathers)

  t.is(app.find('.spinner').text(), 'loading...')

  await flush(app)

  t.is(app.find('.note').text(), 'hello')

  await feathers.service('notes').patch(1, { content: 'realtime' })

  await flush(app)

  t.is(app.find('.note').text(), 'realtime')

  app.unmount()
})

test('useFind', async t => {
  function Note() {
    const notes = useFind('notes')
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const app = mount(Note, feathers)

  await flush(app)

  t.is(app.find('.note').text(), 'hello')

  app.unmount()
})

test('useFind binding updates after realtime create', async t => {
  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' } })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const app = mount(Note, feathers)

  await flush(app)

  t.is(app.find('.note').text(), 'hello')

  await feathers.service('notes').create({ id: 2, content: 'doc', tag: 'idea' })
  await feathers.service('notes').create({ id: 3, content: 'dmc', tag: 'unrelated' })

  await flush(app)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello', 'doc']
  )

  app.unmount()
})

test('useFind binding updates after realtime patch', async t => {
  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' } })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const app = mount(Note, feathers)

  await flush(app)

  t.is(app.find('.note').text(), 'hello')

  await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })

  await flush(app)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['doc']
  )

  app.unmount()
})

test('useFind binding updates after realtime update', async t => {
  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' } })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const app = mount(Note, feathers)

  await flush(app)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello']
  )

  await feathers.service('notes').update(1, { id: 1, content: 'doc', tag: 'idea' })

  await flush(app)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['doc']
  )

  app.unmount()
})

test('useFind binding updates after realtime remove', async t => {
  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' } })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  await feathers.service('notes').create({ id: 2, content: 'doc', tag: 'idea' })

  const app = mount(Note, feathers)

  await flush(app)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello', 'doc']
  )

  await feathers.service('notes').remove(1)

  await flush(app)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['doc']
  )

  app.unmount()
})

test('useFind binding updates after realtime patch with no query', async t => {
  function Note() {
    const notes = useFind('notes')
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const app = mount(Note, feathers)

  await flush(app)

  t.is(app.find('.note').text(), 'hello')

  await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })

  await flush(app)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['doc']
  )

  app.unmount()
})

test('useRealtime listeners are correctly disposed of', async t => {
  let atom

  function Note1() {
    const notes = useFind('notes')
    return <div className='note1'>{notes.data && notes.data[0].content}</div>
  }

  function Note2() {
    const notes = useFind('notes')
    return <div className='note2'>{notes.data && notes.data[0].content}</div>
  }

  function Notes() {
    const figbird = useFigbird()
    atom = figbird.atom

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
  const app = mount(Notes, feathers)

  await flush(app)

  t.is(app.find('.note2').text(), 'hello')
  t.is(atom.get().feathers.entities.notes[1].content, 'hello')

  await feathers.service('notes').patch(1, { content: 'real' })
  t.is(atom.get().feathers.entities.notes[1].content, 'real')

  await flush(app)

  t.deepEqual(
    app.find('.note2').map(n => n.text()),
    ['real']
  )

  app.unmount()

  await feathers.service('notes').patch(1, { content: 'nomo' })

  // should not have updated!
  t.is(atom.get().feathers.entities.notes[1].content, 'real')
})

test('useMutation - multicreate updates cache correctly', async t => {
  let create

  function Note() {
    const notes = useFind('notes')
    const { create: _create } = useMutation('notes')
    create = _create

    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const app = mount(Note, feathers)

  await flush(app)

  create([
    { id: 2, content: 'hi2' },
    { id: 3, content: 'hi3' },
  ])

  await flush(app)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello', 'hi2', 'hi3']
  )
})

test('useMutation patch updates the get binding', async t => {
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
        patch(1, {
          content: content,
        })
      }
    }, [loaded, content])

    return <NoteList notes={note} />
  }

  const feathers = createFeathers()
  const app = mount(Note, feathers)

  await flush(app)

  t.is(app.find('.note').text(), 'hi1')

  setContent('hi2')

  await flush(app)

  t.is(app.find('.note').text(), 'hi2')

  app.unmount()
})

test('useMutation handles errors', async t => {
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
    }, [])

    return <NoteList notes={{ ...note, error }} />
  }

  const feathers = createFeathers()
  feathers.service('notes').patch = () => {
    return Promise.reject(new Error('unexpected'))
  }
  const app = mount(Note, feathers)

  await flush(app)

  t.is(app.find('.error').text(), 'unexpected')

  t.is(handled, 'unexpected')

  app.unmount()
})

test('useFeathers', async t => {
  let feathersFromHook

  function Feathers() {
    const feathers = useFeathers()

    useEffect(() => {
      feathersFromHook = feathers
    }, [])

    return null
  }

  const feathers = createFeathers()
  const app = mount(Feathers, feathers)

  await flush(app)

  t.is(feathersFromHook, feathers)

  app.unmount()
})

test('Provider requires feathers to be passed in', async t => {
  function Feathers() {
    return null
  }

  const app = mount(Feathers, undefined)

  t.is(app.find('.error').text(), 'Please pass in a feathers client')
})

test('support _id out of the box', async t => {
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

  const app = mount(Note, feathers)

  await flush(app)

  t.is(app.find('.note').text(), 'hello _id')

  app.unmount()
})

test('support custom idField string', async t => {
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

  const app = mount(Note, feathers, { idField: '_xid' })

  await flush(app)

  t.is(app.find('.note').text(), 'hello _xid')

  app.unmount()
})

test('support custom idField function', async t => {
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

  const app = mount(Note, feathers, { idField: entity => entity._foo })

  await flush(app)

  t.is(app.find('.note').text(), 'hello _foo')

  app.unmount()
})

test('useFind error', async t => {
  function Note() {
    const notes = useFind('notes')
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  feathers.service('notes').find = () => {
    return Promise.reject(new Error('unexpected'))
  }
  const app = mount(Note, feathers)

  await flush(app)

  t.is(app.find('.error').text(), 'unexpected')

  app.unmount()
})

test('useFind with skip', async t => {
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
  const app = mount(Note, feathers)

  await flush(app)

  t.is(app.find('.data').text(), 'no')

  app.unmount()
})

test('useFind with refetch', async t => {
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

  const app = mount(Note, feathers)

  await flush(app)

  t.is(app.find('.data').text(), '1')

  refetch()

  await flush(app)

  t.is(app.find('.data').text(), '2')

  app.unmount()

  t.is(calls, 2)
})

test('useFind with allPages', async t => {
  function Note() {
    const notes = useFind('notes', { query: { $limit: 1 }, allPages: true })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()

  await feathers.service('notes').create({ id: 2, content: 'doc', tag: 'idea' })
  await feathers.service('notes').create({ id: 3, content: 'dmc', tag: 'unrelated' })

  const app = mount(Note, feathers)

  await flush(app)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello', 'doc', 'dmc']
  )

  app.unmount()
})

test('useFind - realtime merge', async t => {
  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' }, realtime: 'merge' })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const app = mount(Note, feathers)

  await flush(app)

  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello']
  )

  await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })

  await flush(app)

  // no find happened in the backround!
  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['doc']
  )

  app.unmount()
})

test('useFind - realtime refetch', async t => {
  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' }, realtime: 'refetch' })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const app = mount(Note, feathers)

  await flush(app)

  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello']
  )

  await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })

  await flush(app)

  // another find happened in the backround!
  t.is(feathers.service('notes').counts.find, 2)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['doc']
  )

  app.unmount()
})

test('useFind - realtime disabled', async t => {
  let notes

  function Note() {
    const _notes = useFind('notes', { query: { tag: 'idea' }, realtime: 'disabled' })

    useEffect(() => {
      notes = _notes
    })

    return <NoteList notes={_notes} />
  }

  const feathers = createFeathers()
  const app = mount(Note, feathers)

  await flush(app)

  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello']
  )

  await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })

  await flush(app)

  // no find happened in the backround!
  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello']
  )

  notes.refetch()

  await flush(app)

  // another find happened in the backround!
  t.is(feathers.service('notes').counts.find, 2)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['doc']
  )

  app.unmount()
})

test('useFind - fetchPolicy swr', async t => {
  let renderNote

  function App() {
    const [shouldRenderNote, setRenderNote] = useState(true)
    renderNote = setRenderNote
    return shouldRenderNote ? <Note /> : null
  }

  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' }, fetchPolicy: 'swr' })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const app = mount(App, feathers)

  await flush(app)

  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello']
  )

  renderNote(false)
  await flush(app)

  // update note in the meantime
  await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })

  feathers.service('notes').setDelay(30)
  // render 2nd time
  renderNote(true)

  await flush(app)

  // a 2nd find happened in the background
  t.is(feathers.service('notes').counts.find, 2)

  // but we see old note at first
  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello']
  )

  // and then after a while
  await flush(app)

  // we see new note
  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['doc']
  )

  feathers.service('notes').setDelay(0)

  app.unmount()
})

test('useFind - fetchPolicy cache-first', async t => {
  let renderNote

  function App() {
    const [shouldRenderNote, setRenderNote] = useState(true)
    renderNote = setRenderNote
    return shouldRenderNote ? <Note /> : null
  }

  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' }, fetchPolicy: 'cache-first' })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const app = mount(App, feathers)

  await flush(app)

  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello']
  )

  renderNote(false)
  await flush(app)

  // update note in the meantime
  await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })

  // render 2nd time
  renderNote(true)
  await flush(app)

  // no find happened this time, we used cache!
  t.is(feathers.service('notes').counts.find, 1)

  // we see old note
  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello']
  )

  app.unmount()
})

test('useFind - fetchPolicy network-only', async t => {
  let renderNote

  function App() {
    const [shouldRenderNote, setRenderNote] = useState(true)
    renderNote = setRenderNote
    return shouldRenderNote ? <Note /> : null
  }

  function Note() {
    const notes = useFind('notes', { query: { tag: 'idea' }, fetchPolicy: 'network-only' })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const app = mount(App, feathers)

  await flush(app)

  t.is(feathers.service('notes').counts.find, 1)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello']
  )

  renderNote(false)
  await flush(app)

  // update note in the meantime
  await feathers.service('notes').patch(1, { content: 'doc', tag: 'idea' })

  feathers.service('notes').setDelay(30)
  // render 2nd time
  renderNote(true)

  await flush(app)

  // a 2nd find happened in the background
  t.is(feathers.service('notes').counts.find, 2)

  // we see no notes since we're still fetching
  // cache was not used
  t.deepEqual(
    app.find('.note').map(n => n.text()),
    []
  )

  // and then after a while
  await flush(app)

  // we see new note
  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['doc']
  )

  feathers.service('notes').setDelay(0)

  app.unmount()
})

test('useFind - updates correctly after a sequence of create+patch', async t => {
  function Note() {
    const notes = useFind('notes')
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const app = mount(Note, feathers)

  await flush(app)

  t.is(app.find('.note').text(), 'hello')

  await feathers.service('notes').create({ id: 2, content: 'doc' })
  await feathers.service('notes').patch(2, { content: 'doc updated' })

  await flush(app)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello', 'doc updated']
  )

  app.unmount()
})

test('useFind - with custom matcher', async t => {
  const customMatcher = matcher => query => item => {
    return matcher(query)(item) && item.foo
  }

  function Note() {
    const notes = useFind('notes', { query: { tag: 'post' }, matcher: customMatcher })
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers()
  const app = mount(Note, feathers)

  await flush(app)

  t.is(app.find('.note').text(), 'hello')

  await feathers.service('notes').create({ id: 2, tag: 'post', content: 'doc 2', foo: false })
  await feathers.service('notes').create({ id: 3, tag: 'post', content: 'doc 3', foo: true })
  await feathers.service('notes').create({ id: 4, tag: 'draft', content: 'doc 4', foo: true })

  await flush(app)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello', 'doc 3']
  )

  await feathers.service('notes').patch(4, { tag: 'post' })

  await flush(app)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['hello', 'doc 3', 'doc 4']
  )

  app.unmount()
})

test('item gets deleted from cache if it is updated and no longer relevant to a query', async t => {
  let atom

  function Note() {
    const notes = useFind('notes', { query: { tag: 'post' } })
    atom = useFigbird().atom
    return <NoteList notes={notes} />
  }

  const feathers = createFeathers({ noUpdatedAt: true })
  const app = mount(Note, feathers)

  await flush(app)

  t.is(app.find('.note').text(), 'hello')

  await feathers.service('notes').patch(1, { updatedAt: null })
  await feathers.service('notes').patch(1, { tag: 'post', content: 'doc 1', updatedAt: 1 })
  await feathers.service('notes').create({ id: 2, tag: 'post', content: 'doc 2', updatedAt: 2 })
  await feathers.service('notes').create({ id: 3, tag: 'post', content: 'doc 3', updatedAt: 3 })

  await flush(app)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['doc 1', 'doc 2', 'doc 3']
  )

  t.deepEqual(atom.get().feathers.entities, {
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

  t.deepEqual(atom.get().feathers.index, {
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

  await feathers.service('notes').patch(3, { tag: 'draft' })

  await flush(app)

  t.deepEqual(
    app.find('.note').map(n => n.text()),
    ['doc 1', 'doc 2']
  )

  t.deepEqual(atom.get().feathers.entities, {
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

  t.deepEqual(atom.get().feathers.index, {
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

  app.unmount()
})
