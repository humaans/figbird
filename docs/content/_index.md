---
title: 'Figbird'
draft: false
toc: true
---

# Figbird

Effortless realtime data management for [React](https://reactjs.org/) + [Feathers](https://feathersjs.com/) applications. A library used in and extracted from [Humaans](https://humaans.io/).

#### Idiomatic React Hooks

Fetch some data with `const { data } = useFind('notes')` and your components will rerender in realtime as the data changes upstream. Modify the data using the `const { patch } = useMutation('notes')` and the upates will be instantly propagated to all components referencing the same objects.

- `useGet`
- `useFind`
- `useMutation`

#### Live Queries

Works with Feathers realtime events and with local data mutations. Once a record is created/modified/removed all queries referencing this record get updated. For example, if your data is fetched using `useFind('notes', { query: { tag: 'ideas' } })` and you then patch some note with `patch({ tag: 'ideas' })` - the query will updated immediately and rerender all components referencing that query. Adjust behaviour per query:

- `merge` - merge realtime events into cached queries as they come (default)
- `refetch` - refetch data for this query from the server when a realtime event is received
- `disabled` - ignore realtime events for this query

#### Fetch policies

Fetch policies allow you to fine tune Figbird to your requirements. With the default `swr` (stale-while-revalidate) Figbir's uses cached data when possible for maximum responsiveness, but refetches in the background on mount to make sure data is up to date. The other policies are `cache-first` which will use cache and not refresh from the server (compatible with realtime)

- `swr` - show cached data if possible and refetch in the background (default)
- `cache-first` - show cached data if possible and avoid fetching if data is there
- `network-only` - always refetch data on mount

#### Cache eviction

The usage of `useGet` and `useFind` hooks gets reference counted so that Figbird knows exactly if any of the queries are still being referenced by the UI. By default, Figbird will keep all the data and cache without ever evicting, but if your application demands it, you can strategically implement cache eviction hooks (e.g. on page navigation) to clear out all unused cache items or specific items based on service name or data attributes. (Note: yet to be implemnted)

- `manual` - cache all queries in memory forever, evict manually (default)
- `unmount` - remove cached query data on unmount (if no component is referencing that particular cached data anymore)
- `delayed` - remove unused cached data after some time

## Install

```sh
$ npm install figbird
```

## Example

```js
import React, { useState } from 'react'
import io from 'socket.io-client'
import feathers from '@feathersjs/client'
import { Provider, Figbird, FeathersAdapter, useFind } from 'figbird'

const socket = io('http://localhost:3030')
const client = feathers()

client.configure(feathers.socketio(socket))
client.configure(
  feathers.authentication({
    storage: window.localStorage,
  }),
)

const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ adapter })

function App() {
  return (
    <Provider figbird={figbird}>
      <Notes />
    </Provider>
  )
}

function Notes({ tag }) {
  const { status, data, meta } = useFind('notes', { query: { tag } })

  if (status === 'loading') {
    return 'Loading...'
  } else if (status === 'error') {
    return notes.error.message
  }

  return (
    <div>
      Showing {data.length} notes of {meta.total}
    </div>
  )
}
```

## API Reference

### `useGet`

```js
const { data, meta, status, isFetching, error, refetch } = useGet(serviceName, id, params)
```

**Arguments**

- `serviceName` - the name of Feathers service
- `id` - the id of the resource
- `params` - any params you'd pass to a Feathers service call, plus any Figbird params

**Figbird params**

- `skip` - setting to true will not fetch the data
- `realtime` - one of `merge` (default), `refetch` or `disabled`
- `fetchPolicy` - one of `swr` (default), `cache-first` or `network-only`

**Returns**

- `data` - starts of as `null` and is set to the fetch result, usually an object
- `status` - one of `loading`, `success` or `error`
- `isFetching` - true if fetching data for the first time or in the background
- `error` - error object if request failed
- `refetch` - function to refetch data

### `useFind`

```js
const { data, status, isFetching, error, refetch } = useFind(serviceName, params)
```

**Arguments**

- `serviceName` - the name of Feathers service
- `params` - any params you'd pass to Feathers, plus any Figbird params

**Figbird params**

- `skip` - setting true will not fetch the data
- `realtime` - one of `merge` (default), `refetch` or `disabled`
- `fetchPolicy` - one of `swr` (default), `cache-first` or `network-only`
- `allPages` - fetch all pages
- `parallel` - when used in combination with `allPages` will fetch all pages in parallel
- `parallelLimit` - when used in combination with `parallel` limits how many parallel requests to make at once (default: 4)
- `matcher` - custom matcher function of signature `(query, filterItem) => (item) => bool`, used when merging realtime events into local query cache

**Returns**

- `data` - starts of as `null` and is set to the fetch result, usually an array
- `meta` - adapter specific metadata from the `find` envelope, e.g. `{ total, limit, skip }`
- `status` - one of `loading`, `success` or `error`
- `isFetching` - true if fetching data for the first time or in the background
- `error` - error object if request failed
- `refetch` - function to refetch data

### `useMutation`

```js
const { data, status, error, create, update, patch, remove } = useMutation(serviceName, params)
```

**Arguments**

- `serviceName` - the name of Feathers service

**Returns**

- `create(data, params)` - create
- `update(id, data, params)` - update
- `patch(id, data, params)` - patch
- `remove(id, params)` - remove
- `status` - one of `idle`, `loading`, `success` or `error`
- `data` - starts of as `null` and is set to the latest mutation result
- `error` - error object of the last failed mutation

### `useFeathers`

```js
const { feathers } = useFeathers()
```

Get the feathers instance passed to `Provider`.

### `Provider`

```js
<Provider feathers={feathers}>{children}</Provider>
```

- `figbird` - figbird instance

### `Figbird`

```js
const figbird = new Figbird({ adapter )
```

- `adapter` - an instance of a data fetching adapter

### `FeathersAdapter`

A Feathers.js API specific adapter.

```js
const adapter = new FeathersAdapter(feathers, options)
```

- `feathers` - feathers client
- `options`
  - `idField` - string or function, defaults to `item => item.id || item._id`
  - `updatedAtField` - string or function, defaults to `item => item.updatedAt || item.updated_at`, used to avoid overwriting newer data in cache with older data when `get` or realtime `patched` requests are racing
  - `defaultPageSize` - a default page size in `query.$limit` to use when fetching, unset by default so that the server gets to decide
  - `defaultPageSizeWhenFetchingAll` - a default page size to use in `query.$limit` when fetching using `allPages: true`, unset by default so that the server gets to decide

## Realtime

Figbird is compatible with the Feathers realtime model out of the box. The moment you mount a component with a `useFind` or `useGet` hook, Figbird will start listening to realtime events for the services in use. It will only at most subscribe once per service. All realtime events will get processed in the following manner:

- `created` - check if the created object matches any of the cached `find` queries, if so, push it at the end of the array, discard otherwise
- `updated` and `patched` - check if this object is in cache, if so, update
- `removed` - remove this object from cache and any `find` queries referencing it

This behaviour can be configured on a per hook basis by passing a `realtime` param with one of the following values.

### `merge`

This is the default mode that merges all realtime events into cached queries as described above.

### `refetch`

Sometimes, the client does not have the full information to make a decision about how to merge an individual realtime event into the local query result set. For example, if you have a server side query that picks the latest record of each kind and some record is removed - the client might not want to remove it from the query set, but instead show the correct record in it's place. In these cases, setting `realtime` param to `refetch` might be useful.

In `refetch` mode, the `useGet` and `useFind` results are not shared with other components that are in realtime mode, instead the objects are cached locally to those queries and those components. And once a realtime event is received, instead of merging that event as described above, the `find` or `get` is refetched in full. That is, the server told us that something in this service changed, and we use that as a signal to update our local result set.

### `disabled`

Setting `realtime` to `disabled` will not share them with components that are in `realtime` or `refetch` mode. This way, the results will stay as they are even as realtime events are received. You can still manually trigger a refetch using the `refetch` function which is returned by the `useGet` and `useFind` hooks.

## Fetch Policies

Fetch policy controls when Figbird uses data from cache or network and can be configured by passing the `fetchPolicy` param to `useGet` and `useFind` hooks.

### `swr`

This is the default and stands for `stale-while-revalidate`. With this policy, Figbird will show cached data if possible upon mounting the component and will refetch it in the background.

### `cache-first`

With this policy, Figbird will show cached data if possible upon mounting the component and will only fetch data from the server if data was not found in cache.

### `network-only`

With this policy, Figbird will never show cached data on mount and will always fetch on component mount.

## Advanced usage

### Inspect cache contents

If you want to have a look at the cache contents for debugging reasons, you can do so as shown above.

```jsx
import React, { useState } from 'react'
import createFeathersClient from '@feathersjs/feathers'
import { Figbird, FeathersAdapter, Provider } from 'figbird'

const feathers = createFeathersClient()
const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ adapter })

export function App({ children }) {
  return (
    <Provider figbird={figbird}>
      {children}
    </Provider>
  )
}

// inspect the state of all of the queries in figbird
console.log(figbird.getState())

// subscribe to figbird state changes
figbird.subscribeToStateChanges(state => {})
```

### Run queries outside of React

```js
import React, { useState } from 'react'
import createFeathersClient from '@feathersjs/feathers'
import { Figbird, FeathersAdapter } from 'figbird'

const feathers = createFeathersClient()
const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ adapter })

const q = figbird.query({ serviceName: 'notes', method: 'find' })
const unsub = q.subscribe(state => console.log(state)) // fetches data and listens to realtime updates
q.getSnapshot() // read the current state, result is of shape { data, meta, status, isFetching, error }
q.refetch() // manually refetch the query
```


### Use with a custom API

In principle, you could use Figbird with any REST / Websocket / RPC API as long as you wrap your API into a Figbird compatible adapter.

1. Structure your API around services or resources
2. Where the services support operations: `find`, `get`, `create`, `update`, `patch`, `remove`
3. For realtime events, the server should emit a event after each mutation `created`, `patched`, `updated`, `removed`.

For example, if you have a `comments` resource in your application, you would have some or all of the following endpoints:

- `GET /comments`
- `GET /comments/:id`
- `POST /comments`
- `PUT /comments/:id`
- `PATCH /comments/:id`
- `DELETE /comments/id`

The result of the `find` operation or `GET /comments` would be an object of shape `{ data, total, limit, skip }` or similar. You can customise how all this gets mapped to your API by implementing a custom Adapter. See `adapters/feathers.js` for an example.
