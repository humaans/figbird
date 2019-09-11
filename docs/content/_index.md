---
title: "Figbird"
draft: false
toc: true
---

A set of hooks for binding React applications to Feathers APIs.

- `useGet` / `useFind` / `useMutation` / `useFeathers`
- powerful caching with realtime updates
- multiple data fetch policies
- efficient rerenders

## Features

**Idiomatic React hooks**. ...

**Live data**. ...

**Mutations**. ...

**Cache garbage collection**. ...

**Fetch policies**. ...


## useGet

```javascript
import { useGet } from 'figbird'

export function Note({ id }) {
  const note = useGet('notes', id)

  if (note.loading) return 'Loading...'
  if (note.error) return 'Error...'

  return <div>{note.data}</div>
}
```

## useFind

```js
import { useFind } from 'figbird'

export function Notes() {
  const notes = useFind('notes', {})

  if (notes.loading) return 'Loading...'
  if (notes.error) return 'Error...'

  return <div>{notes.data}</div>
}
```

## useFeathers

```js
import { useFeathers } from 'figbird'

export function Logout() {
  const feathers = useFeathers()

  return <button onClick={() => feathers.logout()}>Logout</button>
}
```

## Provider

```js
import React, { useState } from 'react'
import { Provider as FigbirdProvider } from 'figbird'
import createFeathersClient from '@feathersjs/feathers'

export function App({ children }) {
  const [feathers] = useState(() => createFeathersClient())
  return <FigbirdProvider feathers={feathers}>{children}</FigbirdProvider>
}
```

## API Reference

### `useGet(serviceName, id, params)`

- `id` - the id of the resource
- `params` - any params you'd pass to Feathers, with the following extras:
- `skip` - setting skip to true will not fetch the data

Resulting object has the following attributes:

- `data` - starts of as `null` and is set to the fetch result
- `loading` - true if loading data for the first time with nothing in cache
- `reloading` - true loading data in the background to update the cache
- `error` - error object if request failed

### `useFind(serviceName, params)`

- `params` - any params you'd pass to Feathers, with the following extras:
  - `skip` - setting skip to true will not fetch the data

Resulting object has the following attributes:

- `data` - starts of as `null` and is set to the array of data
- `total` - total number of records
- `limit` - max number of items per page
- `skip` - number of skipped items (offset)
- `loading` - true if loading data for the first time with nothing in cache
- `reloading` - true loading data in the background to update the cache
- `error` - error object if request failed

## Advanced usage

Figbird is using [tiny-atom](https://github.com/KidkArolis/tiny-atom) for it's cache. This allows for a succint implementation and efficient bindings from cached data to components. It is possible to pass in a custom instance of tiny-atom to `figbird` if you're already using tiny-atom in your application. The would allow for easier inspection and debugging of your application's state and behaviour. For example:

(screenshot)

### Pass atom via prop

```js
import React, { useState } from 'react'
import { createAtom } from 'tiny-atom'
import { Provider as FigbirdProvider } from 'figbird'
import createFeathersClient from '@feathersjs/feathers'

export function App() {
  const [feathers] = useState(() => createFeathersClient())
  const [atom] = useState(() => createAtom)
  return (
    <FigbirdProvider feathers={feathers} atom={atom}>
      {children}
    </FigbirdProvider>
  )
}
```

### Pass atom via context

```js
import React, { useState } from 'react'
import { AtomContext } from 'tiny-atom'
import { Provider as FigbirdProvider } from 'figbird'
import createFeathersClient from '@feathersjs/feathers'

export function App() {
  const [feathers] = useState(() => createFeathersClient())
  return (
    <FigbirdProvider feathers={feathers} AtomContext={AtomContext}>
      {children}
    </FigbirdProvider>
  )
}
```
