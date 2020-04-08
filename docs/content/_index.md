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

#### Logging

Figbird's cache is implemented using the [`tiny-atom`](https://github.com/KidkArolis/tiny-atom) store which comes with a powerful logger. Observe and inspect all the changes to your cache with ease.

## Install

```sh
$ npm install figbird
```

## Example

```js
import React, { useState } from 'react'
import createFeathersClient from '@feathersjs/feathers'
import { Provider, useFind } from 'figbird'

function App() {
  const [feathers] = useState(() => createFeathersClient())
  return (
    <Provider feathers={feathers}>
      <Notes />
    </Provider>
  )
}

function Notes({ tag }) {
  const { status, data, total } = useFind('notes', { query: { tag } })

  if (status === 'loading') {
    return 'Loading...'
  } else if (status === 'error') {
    return notes.error.message
  }

  return (
    <div>
      Showing {data.length} notes of {total}
    </div>
  )
}
```

## API Reference

### `useGet`

```js
const { data, status, isFetching, error, refetch } = useGet(serviceName, id, params)
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
- `matcher` - custom matcher function of signature `(defaultMatcher) => (query) => (item): bool`, used when merging realtime events into local query cache

**Returns**

- `data` - starts of as `null` and is set to the fetch result, usually an array
- `status` - one of `loading`, `success` or `error`
- `isFetching` - true if fetching data for the first time or in the background
- `error` - error object if request failed
- `refetch` - function to refetch data

The return object also has the rest of the Feathers response mixed, typically:

- `total` - total number of records
- `limit` - max number of items per page
- `skip` - number of skipped items (offset)

### `useMutation`

```js
const { data, status, error, create, update, patch, remove } = useFind(serviceName, params)
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

- `feathers` - feathers instance
- `idField` - string or function, defaults to `item => item.id || item._id`
- `updatedAtField` - string or function, defaults to `item => item.updatedAt || item.updated_at`, used to avoid overwriting newer data in cache with older data when `get` or realtime `patched` requests are racing
- `atom` - custom atom instance
- `AtomContext` - custom atom context

## Realtime

Figbird is compatible with the Feathers realtime model out of the box. The moment you mount a component with a `useFind` or `useGet` hook, Figbird will start listening to realtime events for the services in use. It will only at most subscribe once per service. All realtime events will get processed in the following manner:

- `created` - check if the created object matches any of the cached `find` queries, if so, push it at the end of the array, discard otherwise, note: the created object is only pushed if `data.length === total`, that is if the query has full data set, if the query is paginated and has only a slice of data, the created object will not be pushed, consider using `realtime: 'refetch'` mode for such cases
- `updated` and `patched` - check if this object is in cache, if so, update
- `removed` - remove this object from cache and any `find` queries referencing it

This behaviour can be configured on a per hook basis by passing a `realtime` param with one of the following values.

### `merge`

This is the default mode that merges all realtime events into cached queries as described above.

### `refetch`

Sometimes, the client does not have the full information to make a decision about how to merge an individual realtime event into the local query result set. For example, if you have a server side query that picks the latest record of each kind and some record is removed - the client might not want to remove it from the query set, but instead show the correct record in it's place. In these cases, setting `realtime` param to `refetch` might be useful.

In `refetch` mode, the `useGet` and `useFind` results are not shared with other components that are in realtime mode, instead the objects are cached locally to those queries and those components. And once a realtime event is received, instead of merging that event as described above, the `find` or `get` is refetched in full. That is, the server told us that something in this service changed, and we use that as a signal to update our local result set.

### `disabled`

Setting `realtime` to `disabled` will store the `useGet` and `useFind` results locally and will not share them with components that are in `realtime` or `refetch` mode. This way, the results will stay as they are even as realtime events are received. You can still manually trigger a refetch using the `refetch` function which is returned by the `useGet` and `useFind` hooks.

## Fetch Policies

Fetch policy controls when Figbird uses data from cache or network and can be configured by passing the `fetchPolicy` param to `useGet` and `useFind` hooks.

### `swr`

This is the default and stands for `stale-while-revalidate`. With this policy, Figbird will show cached data if possible upon mounting the component and will refetch it in the background.

### `cache-first`

With this policy, Figbird will show cached data if possible upon mounting the component and will only fetch data from the server if data was not found in cache.

### `network-only`

With this policy, Figbird will never show cached data on mount and will always fetch on component mount.

## Architecture

The idea behind Figbird is rather simple. Fetch all the data requested by the hooks, index all items by id in the cache, listen to realtime events and update all items/queries as neccessary.

Let's take a look at an example. Say, component X uses `useFind('comments')` hook, and component Y uses `useGet('comments/5')` hook. Figbird fetches this data and caches in a structure similar to:

```js
{
  entities: {
    comments: {
      2: { id: 2, content: 'a' },
      4: { id: 4, content: 'b' },
      5: { id: 5, content: 'c' },
      7: { id: 7, content: 'd' },
    }
  }
  queries: {
    comments: {
      'f223315': {
        method: 'find',
        data: [2, 4, 5, 7],
        params: {},
        meta: { total: 4, limit: 100, skip: 0 }
      },
      'g742218': {
        method: 'get',
        id: 5,
        data: [5]
      }
    }
  }
}
```

Now if some other user/client/server makes a modification to the resource already referenced, the cache will be updated. For example, if we receive the following realtime event:

`["comments patched",{"id":4,"content":"b2"}]`.

The entities get updated:

```js
{
  entities: {
    comments: {
      2: { id: 2, content: 'a' },
      4: { id: 4, content: 'b2' }, // updated
      5: { id: 5, content: 'c' },
      7: { id: 7, content: 'd' },
    }
  }
  queries: {
    // ...same as before
  }
}
```

And now the component that was using `useFind` gets rerendered since it's data has been updated, but component using `useGet` does not, since it is not referencing the changed comment.

Hopefully this small example gives you more clarity in how to fit Figbird into your application.

## Advanced usage

### Inspect cache contents

If you want to have a looke at the cache contents for debugging reasons, you can do so as shown above. Note: this is not part of the public API and could change in the future.

```js
function App() {
  const { atom } = useFigbird()

  useEffect(() => {
    // attach the store to window for debugging
    window.atom = atom

    // log the contents of the cache
    console.log(atom.get())

    // listen to changes to the cache
    atom.observe(() => {
      console.log(atom.get())
    })
  }, [atom])
}
```

### Use without Feathers.js

In principle, you could use Figbird with any REST API as long as several conventions are followed or are mapped to. Feathers is a collection of patterns as much as it is a library. In fact, Figbird does not have any code dependencies on Feathers. It's only the Feathers patterns and conventions that the library is designed for. In short, those conventions are:

1. Structure your API around resources
2. Where the resources support operations: `find`, `get`, `create`, `update`, `patch`, `remove`
3. The server should emit a websocket event after each operation (see [Service Events](https://docs.feathersjs.com/api/events.html#service-events))

For example, if you have a `comments` resource in your application, you would have some or all of the following endpoints:

- `GET /comments`
- `GET /comments/:id`
- `POST /comments`
- `PUT /comments/:id`
- `PATCH /comments/:id`
- `DELETE /comments/id`

The result of the `find` operation or `GET /comments` would be an object of shape `{ data, total, limit, skip }` (Note: the pagination envolope will be customizable in Figbird in the future, but it's current fixed to this format).

### Use with existing tiny-atom

Figbird is using [tiny-atom](https://github.com/KidkArolis/tiny-atom) for it's cache. This allows for a succint implementation and efficient bindings from cached data to components. It is possible to pass in a custom instance of tiny-atom to `figbird` if you're already using tiny-atom in your app. This would allow for easier inspection and debugging of your application's state and behaviour. For example, here is the `tiny-atom` logger output:

![Figbird Logger](https://user-images.githubusercontent.com/324440/64800653-d94fec00-d57e-11e9-8b35-5a943a22ebe1.png)

#### Pass atom via prop

```js
import React, { useState } from 'react'
import { createAtom } from 'tiny-atom'
import { Provider } from 'figbird'
import createFeathersClient from '@feathersjs/feathers'

export function App() {
  const [feathers] = useState(() => createFeathersClient())
  const [atom] = useState(() => createAtom())
  return (
    <Provider feathers={feathers} atom={atom}>
      {children}
    </Provider>
  )
}
```

#### Pass atom via context

```js
import React, { useState } from 'react'
import { AtomContext } from 'tiny-atom'
import { Provider } from 'figbird'
import createFeathersClient from '@feathersjs/feathers'

export function App() {
  const [feathers] = useState(() => createFeathersClient())
  return (
    <Provider feathers={feathers} AtomContext={AtomContext}>
      {children}
    </Provider>
  )
}
```
