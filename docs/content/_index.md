---
title: 'Figbird'
draft: false
toc: true
---

# Figbird

A data fetching library for [React](https://reactjs.org/) + [Feathers](https://feathersjs.com/) applications. Used in production at [Humaans](https://humaans.io/).

Figbird gives you React hooks that fetch data and keep it updated. When a record changes - from this component, another component, or a realtime event from the server - every query referencing that data re-renders with the new state. No cache invalidation, no manual refetching.

## Installation

```sh
pnpm add figbird
```

## How It Works

```ts
function Notes() {
  const { data } = useFind('notes')
  const { patch } = useMutation('notes')

  // Updates propagate to all components showing this note
  const markDone = (id) => patch(id, { done: true })

  return data?.map(note => (
    <Note key={note.id} note={note} onDone={markDone} />
  ))
}
```

Queries are live - if a record is created that matches your query, it appears. If it's modified to no longer match, it disappears. This works for local mutations and realtime events from the server.

## Why Figbird

- **Live queries** - results update as records are created, modified, or removed
- **Shared cache** - same data across components, always consistent
- **Realtime built-in** - Feathers websocket events update your UI automatically
- **Pagination hooks** - infinite scroll and page-based navigation with realtime support
- **Fetch policies** - `swr`, `cache-first`, or `network-only` per query
- **Automatic retry** - exponential backoff on failures with configurable stale time
- **Full TypeScript** - define a schema once, get inference everywhere
- **Framework-agnostic core** - works outside React for SSR, testing, or background sync

## Quick Start

```ts
import {
  Figbird,
  FeathersAdapter,
  FigbirdProvider,
  createSchema,
  service,
  createHooks
} from 'figbird'
import { feathersClient } from './feathers'

// Define your schema for type inference
interface Note {
  id: string
  content: string
}

const schema = createSchema({
  services: {
    notes: service<{ item: Note }>(),
  },
})

// Create figbird instance
const figbird = new Figbird({
  adapter: new FeathersAdapter(feathersClient),
  schema
})

// Create typed hooks
export const { useFind, useGet, useMutation } = createHooks(figbird)

// Wrap your app
const App = () => (
  <FigbirdProvider figbird={figbird}>
    <Notes />
  </FigbirdProvider>
)

// Use the hooks
function Notes() {
  const { data, status } = useFind('notes')

  if (status === 'loading') return <>Loading...</>

  return <>{data?.map(note =>
    <div key={note.id}>{note.content}</div>
  )}</>
}
```

# TypeScript

Figbird provides full TypeScript inference through a lightweight schema DSL. Define your services once, and get type safety across all hooks, mutations, and queries - no code generation required.

## Defining a Schema

A schema declares your services and their types. Each service specifies an `item` shape, and optionally custom types for queries and mutation payloads.

```ts
import { createSchema, service } from 'figbird'

interface Task {
  id: string
  title: string
  completed: boolean
}

interface TaskQuery {
  completed?: boolean
}

interface TaskService {
  item: Task
  query?: TaskQuery
}

const schema = createSchema({
  services: {
    tasks: service<TaskService>(),
  },
})
```

Service keys are preserved as literal types - so `'api/people'` and `'tasks'` remain distinct, and all APIs narrow correctly based on the service name you pass.

## Type-Safe Hooks

Once you have a schema, pass it to Figbird and create your hooks. Every hook call is fully typed based on the service name.

```ts
import { Figbird, FeathersAdapter, createHooks } from 'figbird'

const figbird = new Figbird({
  adapter: new FeathersAdapter(feathers),
  schema,
})

const { useFind, useGet, useMutation } = createHooks(figbird)

// Types flow automatically
const tasks = useFind('tasks')       // QueryResult<Task[], FindMeta>
const task = useGet('tasks', '123')  // QueryResult<Task>
```

## Query Parameters

Query parameters combine your domain filters with adapter controls. You define the business-level filters in your schema, and Figbird's adapter adds transport controls like `$limit`, `$sort`, and `$skip`.

```ts
useFind('tasks', {
  query: {
    completed: true,  // domain filter (from TaskQuery)
    $limit: 10,       // adapter control (from Feathers)
    $sort: { title: 1 },
  },
})
```

This separation keeps your schema focused on domain logic while preserving full access to adapter features.

## Typed Mutations

Mutations infer their parameter and return types from your schema. You can optionally define custom payload types for `create`, `update`, and `patch` operations.

```ts
interface TaskService {
  item: Task
  query?: TaskQuery
  create?: { title: string; completed?: boolean }
  patch?: { title?: string; completed?: boolean }
}
```

If you omit payload types, Figbird uses sensible defaults: `Partial<item>` for create and patch, and `item` for update (full replacement).

```ts
const { create, patch, remove } = useMutation('tasks')

const newTask = await create({ title: 'Ship it' })  // typed payload, returns Task
await patch('id-1', { completed: true })            // typed patch payload
await remove('id-1')                                // returns removed Task
```

## Custom Service Methods

Feathers services often expose custom methods beyond CRUD. Define them in your schema to get full type safety when calling them through the Feathers client.

```ts
interface NotesService {
  item: Note
  methods: {
    archive: (ids: string[]) => Promise<{ count: number }>
    search: (term: string, limit?: number) => Promise<Note[]>
  }
}

const schema = createSchema({
  services: {
    notes: service<NotesService>(),
  },
})
```

Access custom methods through the typed Feathers client returned by `useFeathers`:

```ts
const { useFeathers } = createHooks(figbird)
const feathers = useFeathers()

await feathers.service('notes').archive(['1', '2'])  // { count: number }
await feathers.service('notes').search('hello')      // Note[]
```

# API Reference

## useGet

Fetches a single resource by ID. The result stays in sync with realtime events and is shared across components using the same query.

```ts
// Untyped usage
const { data, status, isFetching, error, refetch } = useGet(serviceName, id, params)

// Typed usage with createHooks(figbird)
const { useGet } = createHooks(figbird)
const note = useGet('notes', '1') // note: QueryResult<Note>
```

#### Arguments

- `serviceName` - the name of Feathers service
- `id` - the id of the resource
- `params` - any params you'd pass to a Feathers service call, plus any Figbird params

#### Figbird params

- `skip` - setting to true will not fetch the data
- `realtime` - one of `merge` (default), `refetch` or `disabled`
- `fetchPolicy` - one of `swr` (default), `cache-first` or `network-only`
- `retry` - number of retry attempts on failure, or `false` to disable (default: 3)
- `retryDelay` - delay between retries in ms, or function `(attempt) => ms` (default: exponential backoff)
- `staleTime` - time in ms that data is considered fresh (default: 30000)
- `refetchOnWindowFocus` - refetch stale data when window regains focus (default: true)

#### Returns

- `data` - starts as `null` and is set to the fetch result (single item)
- `status` - one of `loading`, `success` or `error`
- `isFetching` - `true` if fetching data for the first time or in the background
- `error` - error object if request failed
- `refetch` - function to refetch data

Note: By default, `useGet` does not expose `meta`. Adapters may return meta for get operations, but the built-in FeathersAdapter returns only the item.

## useFind

Fetches a list of resources matching a query. Results update automatically when records are created, modified, or removed - either locally or via realtime events.

```ts
// Untyped usage
const { data, meta, status, isFetching, error, refetch } = useFind(serviceName, params)

// Typed usage with createHooks(figbird)
const { useFind } = createHooks(figbird)
const notes = useFind('notes') // QueryResult<Note[], FindMeta>
```

#### Arguments

- `serviceName` - the name of Feathers service
- `params` - any params you'd pass to Feathers, plus any Figbird params

#### Figbird params

- `skip` - setting true will not fetch the data
- `realtime` - one of `merge` (default), `refetch` or `disabled`
- `fetchPolicy` - one of `swr` (default), `cache-first` or `network-only`
- `allPages` - fetch all pages
- `parallel` - when used in combination with `allPages` will fetch all pages in parallel
- `parallelLimit` - when used in combination with `parallel` limits how many parallel requests to make at once (default: 4)
- `matcher` - custom matcher function of signature `(query) => (item) => bool`, used when merging realtime events into local query cache
- `retry` - number of retry attempts on failure, or `false` to disable (default: 3)
- `retryDelay` - delay between retries in ms, or function `(attempt) => ms` (default: exponential backoff)
- `staleTime` - time in ms that data is considered fresh (default: 30000)
- `refetchOnWindowFocus` - refetch stale data when window regains focus (default: true)

#### Returns

- `data` - starts as `null` and is set to the fetch result (array)
- `meta` - adapter-specific metadata from the `find` envelope, e.g. `{ total, limit, skip }` (type: `FindMeta` with FeathersAdapter)
- `status` - one of `loading`, `success` or `error`
- `isFetching` - `true` if fetching data for the first time or in the background
- `error` - error object if request failed
- `refetch` - function to refetch data

## useInfiniteFind

Fetches resources with infinite scroll / "load more" pagination. Data accumulates across pages as you call `loadMore()`. Supports both cursor-based and offset-based pagination.

```ts
const {
  data,
  meta,
  status,
  isFetching,
  isLoadingMore,
  hasNextPage,
  loadMore,
  refetch,
  error,
  loadMoreError,
} = useInfiniteFind('notes', {
  query: { $sort: { createdAt: -1 } },
  limit: 20,
})
```

#### Arguments

- `serviceName` - the name of Feathers service
- `config` - configuration object

#### Config options

- `query` - query parameters for filtering/sorting
- `limit` - page size (uses adapter default if not specified)
- `skip` - setting to true will not fetch the data
- `realtime` - one of `merge` (default), `refetch` or `disabled`
- `matcher` - custom matcher function for realtime events
- `sorter` - custom sorter for inserting realtime events in correct order

Pagination logic is configured at the adapter level. See `FeathersAdapter` options for `getNextPageParam` and `getHasNextPage`.

#### Returns

- `data` - accumulated data from all loaded pages (array)
- `meta` - metadata from the last fetched page
- `status` - one of `loading`, `success` or `error`
- `isFetching` - `true` if any fetch is in progress
- `isLoadingMore` - `true` if loading more pages
- `hasNextPage` - whether more pages are available
- `loadMore` - function to load the next page
- `refetch` - function to refetch from the beginning
- `error` - error from initial fetch
- `loadMoreError` - error from loadMore operation

## usePaginatedFind

Fetches resources with traditional page-based navigation. Shows one page at a time with navigation controls. Previous page data stays visible during transitions for a smooth UX.

Supports both offset pagination (random access to any page) and cursor pagination (sequential navigation only). The mode is auto-detected from the server response:
- **Offset mode**: Server returns `total` - all navigation methods work, `totalPages` is computed
- **Cursor mode**: Server returns `endCursor` or no `total` - `totalPages` is -1, `setPage(n)` silently ignores non-sequential jumps, `nextPage()`/`prevPage()` work using cursor history

```ts
const {
  data,
  meta,
  status,
  page,
  totalPages,
  hasNextPage,
  hasPrevPage,
  setPage,
  nextPage,
  prevPage,
  refetch,
} = usePaginatedFind('notes', {
  query: { $sort: { createdAt: -1 } },
  limit: 20,
})
```

#### Arguments

- `serviceName` - the name of Feathers service
- `config` - configuration object (limit is required)

#### Config options

- `query` - query parameters for filtering/sorting
- `limit` - page size (required)
- `initialPage` - starting page number, 1-indexed (default: 1)
- `skip` - setting to true will not fetch the data
- `realtime` - one of `refetch` (default), `merge` or `disabled`. Refetch is recommended for pagination since creates/removes can shift page boundaries.

#### Returns

- `data` - data for the current page (array)
- `meta` - metadata for the current page
- `status` - one of `loading`, `success` or `error`
- `isFetching` - `true` if fetching data
- `error` - error object if request failed
- `page` - current page number (1-indexed)
- `totalPages` - total number of pages (-1 for cursor mode)
- `hasNextPage` - whether there is a next page
- `hasPrevPage` - whether there is a previous page
- `setPage` - function to navigate to a specific page (silently ignores non-sequential jumps in cursor mode)
- `nextPage` - function to go to next page
- `prevPage` - function to go to previous page
- `refetch` - function to refetch current page

## useMutation

Provides methods to create, update, patch, and remove resources. Mutations automatically update the cache, so all components using related queries re-render with fresh data.

```ts
const { data, status, error, create, update, patch, remove } = useMutation(serviceName, params)
```

#### Arguments

- `serviceName` - the name of Feathers service

#### Returns

- `create(data, params)` - create
- `update(id, data, params)` - update
- `patch(id, data, params)` - patch
- `remove(id, params)` - remove
- `status` - one of `idle`, `loading`, `success` or `error`
- `data` - starts off as `null` and is set to the latest mutation result
- `error` - error object of the last failed mutation

## useFeathers

Returns the underlying Feathers client for direct service access. Useful for one-off operations, custom methods, or when you need the client outside of Figbird's caching layer.

```ts
const { useFeathers } = createHooks(figbird)
const feathers = useFeathers()

const note = await feathers.service('notes').get('1')
await feathers.service('notes').create({ title: 'Hi' })
await feathers.service('notes').patch('1', { content: 'Updated' })
```

When created via `createHooks`, returns a `TypedFeathersClient` with full type safety for all service methods based on your schema.

## Figbird

The core class that manages query state, caching, and realtime event processing. Create one instance and share it across your app via the Provider.

```ts
const figbird = new Figbird({ adapter, schema })
```

#### Arguments

- `adapter` - an instance of a data fetching adapter
- `schema` - optional schema to enable full TypeScript inference
- `defaultQueryConfig` - optional global defaults for query options

```ts
const figbird = new Figbird({
  adapter,
  schema,
  defaultQueryConfig: {
    retry: 3,
    retryDelay: 1000,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  },
})
```

These defaults apply to all queries and can be overridden per-query.

## FeathersAdapter

Connects Figbird to a Feathers.js backend. Handles data fetching, realtime subscriptions, and translates between Figbird's query format and Feathers conventions.

```ts
const adapter = new FeathersAdapter(feathers, options)
```

#### Arguments

- `feathers` - feathers client
- `options`
  - `idField` - string or function, defaults to `item => item.id || item._id`
  - `updatedAtField` - string or function, defaults to `item => item.updatedAt || item.updated_at`, used to avoid overwriting newer data in cache with older data when `get` or realtime `patched` requests are racing
  - `defaultPageSize` - a default page size in `query.$limit` to use when fetching, unset by default so that the server gets to decide
  - `defaultPageSizeWhenFetchingAll` - a default page size to use in `query.$limit` when fetching using `allPages: true`, unset by default so that the server gets to decide
  - `getNextPageParam` - function `(meta, data) => string | number | null` to extract next page param from response. Auto-detects by default: uses `meta.endCursor` for cursor pagination, otherwise calculates next `$skip` for offset pagination
  - `getHasNextPage` - function `(meta, data) => boolean` to determine if more pages exist. Uses `meta.hasNextPage` if available, otherwise derives from `getNextPageParam`

Meta behavior:

- `find` returns `{ data, meta }` where `meta` is of type `FindMeta`
- `get` returns only `{ data }` by default (no meta)

## Provider

React context provider that makes the Figbird instance available to all hooks in your component tree. Wrap your app once at the root.

```tsx
<FigbirdProvider figbird={figbird}>{children}</FigbirdProvider>
```

#### Props

- `figbird` - figbird instance

## createHooks

`createHooks(figbird)` binds a Figbird instance (with its schema and adapter) to typed React hooks. It returns `{ useFind, useGet, useInfiniteFind, usePaginatedFind, useMutation, useFeathers }` with full service- and adapter-aware TypeScript types.

```ts
import { Figbird, FeathersAdapter, createHooks } from 'figbird'

const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ adapter, schema })
export const {
  useFind,
  useGet,
  useInfiniteFind,
  usePaginatedFind,
  useMutation,
  useFeathers,
} = createHooks(figbird)

// Later in components
function People() {
  // serviceName literal narrows types
  const res = useFind('api/people', { query: { name: 'Ada', $limit: 10 } })
  //          ^ QueryResult<Person[], FindMeta>
  return <div>{res.data?.length ?? 0}</div>
}

function TaskView({ id }: { id: string }) {
  const res = useGet('tasks', id)
  //          ^ QueryResult<Task> (no meta by default)
  return <div>{res.data?.title}</div>
}
```

#### Arguments

* `figbird` - figbird instance

# Advanced Usage

## Realtime

Figbird is compatible with the Feathers realtime model out of the box. The moment you mount a component with a `useFind` or `useGet` hook, Figbird will start listening to realtime events for the services in use. It will only at most subscribe once per service. All realtime events will get processed in the following manner:

- `created` - check if the created object matches any of the cached `find` queries, if so, push it at the end of the array, discard otherwise
- `updated` and `patched` - check if this object is in cache, if so, update
- `removed` - remove this object from cache and any `find` queries referencing it

This behaviour can be configured on a per hook basis by passing a `realtime` param with one of the following values.

### merge

This is the default mode that merges all realtime events into cached queries as described above.

### refetch

Sometimes, the client does not have the full information to make a decision about how to merge an individual realtime event into the local query result set. For example, if you have a server side query that picks the latest record of each kind and some record is removed - the client might not want to remove it from the query set, but instead show the correct record in its place. In these cases, setting `realtime` param to `refetch` might be useful.

In `refetch` mode, the `useGet` and `useFind` results are not shared with other components that are in realtime mode, instead the objects are cached locally to those queries and those components. And once a realtime event is received, instead of merging that event as described above, the `find` or `get` is refetched in full. That is, the server told us that something in this service changed, and we use that as a signal to update our local result set.

### disabled

Setting `realtime` to `disabled` will not share them with components that are in `realtime` or `refetch` mode. This way, the results will stay as they are even as realtime events are received. You can still manually trigger a refetch using the `refetch` function which is returned by the `useGet` and `useFind` hooks.

## Fetch policies

Fetch policy controls when Figbird uses data from cache or network and can be configured by passing the `fetchPolicy` param to `useGet` and `useFind` hooks.

### swr

This is the default and stands for `stale-while-revalidate`. With this policy, Figbird will show cached data if possible upon mounting the component and will refetch it in the background.

### cache-first

With this policy, Figbird will show cached data if possible upon mounting the component and will only fetch data from the server if data was not found in cache.

### network-only

With this policy, Figbird will never show cached data on mount and will always fetch on component mount.

## Retry and data freshness

Figbird provides built-in retry logic and freshness control to handle network failures and keep data up to date.

### Automatic retry

Failed fetches automatically retry with exponential backoff. By default, queries retry 3 times with delays of 1s, 2s, 4s (capped at 30s).

```ts
// Disable retry for a specific query
useFind('notes', { retry: false })

// Custom retry count
useFind('notes', { retry: 5 })

// Fixed delay between retries
useFind('notes', { retryDelay: 2000 })

// Custom delay function
useFind('notes', { retryDelay: (attempt) => attempt * 1000 })
```

### Stale time

The `staleTime` option controls how long data is considered "fresh" before Figbird will refetch in the background. This prevents refetch storms from rapid tab switching while still catching missed realtime events.

```ts
// Data is fresh for 60 seconds
useFind('notes', { staleTime: 60_000 })

// Always refetch (staleTime of 0)
useFind('notes', { staleTime: 0 })
```

Default is 30 seconds - a balance between responsiveness and efficiency.

### Refetch on window focus

When enabled (default), Figbird refetches stale queries when the browser window regains focus. This catches any realtime events that may have been missed while the tab was in the background.

```ts
// Disable for a specific query
useFind('notes', { refetchOnWindowFocus: false })
```

## Inspect cache contents

If you want to have a look at the cache contents for debugging reasons, you can do so as shown below.

```jsx
import createFeathersClient from '@feathersjs/feathers'
import { Figbird, FeathersAdapter, FigbirdProvider } from 'figbird'

const feathers = createFeathersClient()
const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ adapter })

export function App({ children }) {
  return (
    <FigbirdProvider figbird={figbird}>
      {children}
    </FigbirdProvider>
  )
}

// inspect the state of all of the queries in figbird
console.log(figbird.getState())

// subscribe to figbird state changes
figbird.subscribeToStateChanges(state => {})
```

## Using outside React

Figbird's core is framework-agnostic. You can create and subscribe to queries directly without React, which is useful for background sync, testing, or non-React parts of your app.

```ts
const figbird = new Figbird({ adapter, schema })

const query = figbird.query({
  serviceName: 'tasks',
  method: 'find',
  params: { query: { completed: true } },
})

// Subscribe to get data and updates
const unsub = query.subscribe(state => {
  console.log(state.data)  // Task[] | null
  console.log(state.status) // 'loading' | 'success' | 'error'
})

// { data, meta, status, isFetching, error }
query.getSnapshot()

// Manually refetch
query.refetch()

// Clean up
unsub()
```

## Custom API adapters

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
- `DELETE /comments/:id`

The result of the `find` operation or `GET /comments` would be an object of shape `{ data, total, limit, skip }` or similar. You can customise how all this gets mapped to your API by implementing a custom Adapter. See `adapters/feathers.js` for an example.
