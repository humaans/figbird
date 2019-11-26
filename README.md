# Figbird

Declarative and realtime data management for **ultra responsive** Feathers and React applications.

- idiomatic React hooks – `useGet` / `useFind` / `useMutation` / `useFeathers`
- powerful caching with realtime updates and live queries
- multiple data fetching policies
- fine control over cache evictions

The library has been extracted from production code used at https://humaans.io/.

## Features

**Idiomatic React hooks**. Works how you'd expect it, fetch some data with `const data = useFind('notes')` and know that your components will rerender in realtime as the data upstream changes. Modify the data using the `const { patch } = useMutation` and have the updates be instantly propagated to all components referencing the same entities.

**Live queries**. Works with both Feathers realtime events and with local data mutations. Sophisticated and Feathers compatible live query support means that when you patch a record it gets added or removed to any queries matching this record. For example, if your data is fetched using `useFind('notes', { query: { tag: 'ideas' } })` and you then patch some note with `patch({ tag: 'ideas' })` - the query will updated immediately and rerender all components referencing that query.

**Cache eviction**. The usage of `useGet` and `useFind` hooks gets reference counted so that Figbird knows exactly if any of the queries and fetched entities are still being referenced by the UI. By default, Figbird will keep all the data and cache without ever evicting, but if your application demands it, you can strategically implement cache eviction hooks (e.g. on page navigations) to clear out all unused cache items or specific items based on service name or data attributes.

**Fetch policies**. Fetch policies allow you to fine tune Figbird to your requirements. With the default `cache-and-network` you will use cached data when possible for maximum responsiveness, but will always refetch in the background to make sure data is up to date. Or use one of the other 4 policies to minimise network usage or always go to network first.

**Logging**. Figbird's cache is implemented using the [`tiny-atom`](https://github.com/KidkArolis/tiny-atom) store which comes with a powerful logger. Observe and inspect all the changes to your cache with ease.

## TODO

- [x] `useGet`
- [x] `useFind`
- [x] `useMutations`
- [x] `useFeathers`
- [x] `error` and `loading` state in `useMutation`
- [x] manual `refetch` for gets and finds
- [ ] reuse inflight requests for identical get/find requests

Options

- [x] option - custom `id` field
- [ ] option - logger
- [ ] option - disable realtime
- [ ] option - disable cache

Cache

- [x] cache all results and queries
- [x] live update queries on entity updates
- [x] fetch policy `cache-and-network`
- [ ] fetch policy `cache-first`
- [ ] fetch policy `network-only`
- [ ] fetch policy `no-cache`
- [ ] fetch policy `cache-only`
- [ ] useCacheEviction - sweep through cache and remove any queries or entities, e.g. clean('notes')
- [ ] ref counting - do not remove entities/queries if they're actively used

Pagination

- [x] `useFind` - pagination metadata
- [x] `useFind` - handle updates to paginated queries
- [x] `useFind` - `allPages`
- [ ] `useFind` - `fetchMore`
- [ ] support `find` without pagination envelope

Bugs

- [ ] bug: unmounting should not stop listening if other components need to

## useGet

Fetch a resource by id, calls `feathers.service('notes').get(id, params)`.

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
import { Provider as FigbirdProvider } from 'figbird'
import createFeathersClient from '@feathersjs/feathers'

export function App({ children }) {
  const [feathers] = useState(() => createFeathersClient())
  return <FigbirdProvider feathers={feathers}>{children}</FigbirdProvider>
}
```

## API Reference

### `useGet(serviceName, id, params)`

- `serviceName` - the name of Feathers service
- `id` - the id of the resource
- `params` - any params you'd pass to Feathers, with the following extras:
  - `skip` - setting skip to true will not fetch the data

Resulting object has the following attributes:

- `data` - starts of as `null` and is set to the fetch result
- `loading` - true if loading data for the first time with nothing in cache
- `reloading` - true loading data in the background to update the cache
- `error` - error object if request failed
- `refetch` - refetch the data

### `useFind(serviceName, params)`

- `serviceName` - the name of Feathers service
- `params` - any params you'd pass to Feathers, with the following extras:
  - `skip` - setting skip to true will not fetch the data
  - `allPages` - fetch all pages

Resulting object has the following attributes:

- `data` - starts of as `null` and is set to the array of data
- `total` - total number of records
- `limit` - max number of items per page
- `skip` - number of skipped items (offset)
- `loading` - true if loading data for the first time with nothing in cache
- `reloading` - true loading data in the background to update the cache
- `error` - error object if request failed
- `refetch` - refetch the data

### `useMutation(serviceName)`

- `serviceName` - the name of Feathers service

Resulting object has the following attributes:

- `create(data)` - create
- `update(id, data)` - update
- `patch(id, data)` - patch
- `remove(id)` - remove
- `loading` - true if the last called mutation is in flight
- `error` - error object of the last failed mutation

### `Provider`

- `feathers` - feathers instance
- `idField` - optional, string or function, defaults to getting `id` and then `_id`
- `atom` - optional, custom atom instance
- `AtomContext` - optional, custom atom context

## Advanced usage

Figbird is using [tiny-atom](https://github.com/KidkArolis/tiny-atom) for it's cache. This allows for a succint implementation and efficient bindings from cached data to components. It is possible to pass in a custom instance of tiny-atom to `figbird` if you're already using tiny-atom in your appsta would allow for easier inspection and debugging of your application's state and behaviour. For example:

![Figbird Logger](https://user-images.githubusercontent.com/324440/64800653-d94fec00-d57e-11e9-8b35-5a943a22ebe1.png)

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
