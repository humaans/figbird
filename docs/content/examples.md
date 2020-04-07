```js
import { useGet } from 'figbird'

export function Note({ id }) {
  const note = useGet('notes', id)

  if (note.loading) return 'Loading...'
  if (note.error) return 'Error...'

  return <div>{note.data}</div>
}
```

## useFind

Fetch a collection, calls `feathers.service('notes').find(params)`.

```js
import { useFind } from 'figbird'

export function Notes({ tag }) {
  const notes = useFind('notes', { query: { tag } })

  if (notes.loading) return 'Loading...'
  if (notes.error) return 'Error...'

  return <div>{notes.data}</div>
}
```

## useMutation

Fetch a collection, calls `feathers.service('notes').find(params)`.

```js
import { useMutation } from 'figbird'

export function Note({ id }) {
  const { patch, loading, error } = useMutation('notes')

  if (loading) return 'Updating...'
  if (error) return 'Error...'

  return <button onClick={() => patch(id, { tag: 'idea' })}>Add tag</div>
}
```

## useFeathers

Get feathers client.

```js
import { useFeathers } from 'figbird'

export function Logout() {
  const feathers = useFeathers()

  return <button onClick={() => feathers.logout()}>Logout</button>
}
```

## useFigbird

Advanced. Get all of Figbird's context, including `{ feathers, config, atom, actions, useSelector }`.

```js
import { useFeathers } from 'figbird'

export function Logout() {
  const figbird = useFigbird()

  useEffect(() => {
    // e.g. inspect cache contents
    window.figbird = figbird
    console.log(figbird.atom.get())
  }, [])
}
```

## Provider

Every application using Figbird must be wrapped in Figbird `Provider`.

```js
import React, { useState } from 'react'
import { Provider, useFind } from 'figbird'
import createFeathersClient from '@feathersjs/feathers'

function App({ feathers, children }) {
  const [feathers] = useState(() => createFeathersClient())
  return <Provider feathers={feathers}>{children}</Provider>
}

function Notes({ tag }) {
  const notes = useFind('notes', { query: { tag } })

  if (notes.status === 'loading') return 'Loading...'
  if (notes.status === 'error') return notes.error.message

  return <div>{notes.data}</div>
}
```
