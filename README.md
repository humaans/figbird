# Figbird

Declarative realtime data management for snappy React + Feathers applications.

- idiomatic React hooks – `useGet` / `useFind` / `useMutation` / `useFeathers`
- powerful caching with realtime updates and live queries
- multiple data fetching policies
- fine control over cache evictions

The library has been extracted from production code at https://humaans.io/.

## Features

### Idiomatic React hooks

Works how you'd expect it, fetch some data with `const data = useFind('notes')` and know that your components will rerender in realtime as the data upstream changes. Modify the data using the `const { patch } = useMutation('notes')` and have the updates be instantly propagated to all components referencing the same entities.

- `useGet`
- `useFind`
- `useMutation`

### Live queries

Works with both Feathers realtime events and with local data mutations. Sophisticated and Feathers compatible live query support means that when you patch a record it gets added or removed to any queries matching this record. For example, if your data is fetched using `useFind('notes', { query: { tag: 'ideas' } })` and you then patch some note with `patch({ tag: 'ideas' })` - the query will updated immediately and rerender all components referencing that query. Adjust how this works per query:

- `merge` - merge realtime events into cached queries as they come
- `refetch` - refetch the query when realtime event is received
- `disabled` - do not update cached data on realtime events

### Fetch policies

Fetch policies allow you to fine tune Figbird to your requirements. With the default `swr` (stale-while-revalidate) Figbir's uses cached data when possible for maximum responsiveness, but refetches in the background on mount to make sure data is up to date. The other policies are `cache-first` which will use cache and not refresh from the server (compatible with realtime)

- `swr` - show cached data if possible and refetch in the background
- `cache-first` - show cached data if possible without refetching
- `network-only` - always refetch the data on mount

### Cache eviction

The usage of `useGet` and `useFind` hooks gets reference counted so that Figbird knows exactly if any of the queries and fetched entities are still being referenced by the UI. By default, Figbird will keep all the data and cache without ever evicting, but if your application demands it, you can strategically implement cache eviction hooks (e.g. on page navigations) to clear out all unused cache items or specific items based on service name or data attributes. (TBD)

- `manual` - cache all queries in memory forever, evict manually
- `unmount` - remove cached query data on unmount (if no component is referencing that particular cached data anymore)
- `delayed` - remove unused cached data after some time

### Logging

Figbird's cache is implemented using the [`tiny-atom`](https://github.com/KidkArolis/tiny-atom) store which comes with a powerful logger. Observe and inspect all the changes to your cache with ease.

## API Reference

Visit the [documentation site](https://humaans.github.io/figbird/) for full API reference.

## Roadmap

- [x] `useGet`
- [x] `useFind`
- [x] `useMutations`
- [x] `useFeathers`
- [x] `refetch` for manual data refetching
- [x] reuse inflight requests for identical get/find requests
- [ ] support React Suspense and Concurrent Mode

Options

- [x] option - custom `id` field
- [x] option - custom `updatedAt` field
- [ ] option - logger

Cache

- [x] cache all results and queries
- [x] live update queries on entity updates
- [x] realtime mode `merge` that merges updates into cached entities and query
- [x] realtime mode `refetch` that keeps stale data, but refetches from server, useful for complex queries
- [x] realtime mode `disabled` to disable realtime updates
- [x] fetch policy `swr` (aka, `stale-while-revalidate`, show cached data, but refetch, the default)
- [x] fetch policy `cache-first`
- [x] fetch policy `network-only`
- [ ] cache eviction `manual`
- [ ] cache eviction `unmount`
- [ ] cache eviction `delayed`
- [ ] cache eviction ttl `ttl`
- [ ] useCacheEviction - sweep through cache and remove any queries or entities, e.g. clean('notes')
- [ ] ref counting - do not remove entities/queries if they're actively used

Pagination

- [x] `useFind` - pagination metadata
- [x] `useFind` - handle updates to paginated queries
- [x] `useFind` - `allPages` to fetch all pages
- [ ] `useFind` - `fetchMore`
- [ ] support `find` without pagination envelope
- [ ] support `find` with custom pagination envelope

Bugs

- [x] bug: unmounting should not stop listening if other components need to
