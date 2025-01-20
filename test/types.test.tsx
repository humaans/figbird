import React, { StrictMode } from 'react'
import test from 'ava'
import { dom, mockFeathers } from './helpers'
import {
  Figbird,
  Provider,
  FeathersAdapter,
  useFind,
  createSchema,
  createServiceSchema,
  InferServiceType,
} from '../lib'

const createFeathers = () =>
  mockFeathers({
    notes: {
      data: {
        1: {
          id: 1,
          content: 'hello',
          updatedAt: new Date('2024-02-02').getTime(),
        },
      },
    },
    tags: {
      data: {
        1: {
          id: 1,
          content: 'journal',
          updatedAt: new Date('2024-02-03').getTime(),
        },
      },
    },
  })

function App({ figbird, children }) {
  return (
    <StrictMode>
      <Provider figbird={figbird}>{children}</Provider>
    </StrictMode>
  )
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

test('useFind with typed schema', async t => {
  const { render, unmount, flush, $ } = dom()

  // Define the schema types
  const noteSchema = createServiceSchema({
    serviceName: 'notes',
    properties: {
      id: 'number',
      content: 'string',
      updatedAt: 'number',
      tagId: 'number',
    },
  })

  const tagSchema = createServiceSchema({
    serviceName: 'tags',
    properties: {
      id: 'number',
      name: 'string',
      color: 'string',
    },
  })

  const schema = createSchema({
    services: {
      notes: noteSchema,
      tags: tagSchema,
    },
  })

  type Tag = InferServiceType<typeof schema, 'tags'>
  type Note = InferServiceType<typeof schema, 'notes'>
  type Schema = typeof schema

  const feathers = createFeathers()
  const adapter = new FeathersAdapter<Schema>(feathers, { schema })
  const figbird = new Figbird({ adapter, schema })

  let tagData: Tag[] | null = null
  let noteData: Note[] | null = null

  function Note() {
    const _tags = useFind<Schema, 'tags'>('tags')
    const _notes = useFind<Schema, 'notes'>('notes')
    noteData = _notes.data
    tagData = _tags.data
    return <NoteList notes={_notes} />
  }

  render(
    <App figbird={figbird}>
      <Note />
    </App>,
  )

  t.is($('.spinner').innerHTML, 'loading...')

  await flush()

  t.is($('.note').innerHTML, 'hello')
  t.deepEqual(noteData, [{ id: 1, content: 'hello', updatedAt: 1706832000000 }])
  t.deepEqual(tagData, [{ id: 1, content: 'journal', updatedAt: 1706918400000 }])

  unmount()
})
