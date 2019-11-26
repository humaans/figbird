import React, { useEffect } from 'react'
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
          content: 'hello'
        }
      }
    }
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
    if (error.message === 'Please pass in a feathers client') {
      return { hasError: true, error: error.message }
    }
    return {}
  }

  // componentDidCatch(error) {
  //   console.log('CAUGHT!?', error.message === 'Please pass in a feathers client')
  //   if (error.message === 'Please pass in a feathers client') return
  //   throw error
  // }

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

  t.deepEqual(app.find('.note').map(n => n.text()), ['hello', 'doc'])

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

  t.deepEqual(app.find('.note').map(n => n.text()), ['doc'])

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

  t.deepEqual(app.find('.note').map(n => n.text()), ['hello'])

  await feathers.service('notes').update(1, { id: 1, content: 'doc', tag: 'idea' })

  await flush(app)

  t.deepEqual(app.find('.note').map(n => n.text()), ['doc'])

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

  t.deepEqual(app.find('.note').map(n => n.text()), ['hello', 'doc'])

  await feathers.service('notes').remove(1)

  await flush(app)

  t.deepEqual(app.find('.note').map(n => n.text()), ['doc'])

  app.unmount()
})

test('useMutation patch updates the get binding', async t => {
  function Note() {
    const note = useGet('notes', 1)
    const { patch } = useMutation('notes')

    useEffect(() => {
      patch(1, {
        content: 'hi'
      })
    }, [])

    return <NoteList notes={note} />
  }

  const feathers = createFeathers()
  const app = mount(Note, feathers)

  await flush(app)

  const noteEl = app.find('.note')
  t.is(noteEl.text(), 'hi')

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
          content: 'hello _id'
        }
      }
    }
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
          content: 'hello _xid'
        }
      }
    }
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
          content: 'hello _foo'
        }
      }
    }
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

test('useFind with skip', async t => {
  function Note() {
    const notes = useFind('notes', {
      skip: true
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
