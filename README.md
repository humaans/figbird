# Figbird

> Declarative realtime data management for snappy React + Feathers applications.

The library has been extracted from production code at https://humaans.io/.

## Features

### Idiomatic React Hooks

Fetch some data with `const { data } = useFind('notes')` and know that your components will rerender in realtime as the data upstream changes. Modify the data using the `const { patch } = useMutation('notes')` and have the updates be instantly propagated to all components referencing the same objects.

- `useGet`
- `useFind`
- `useMutation`

### Live Queries

Works with Feathers realtime events and with local data mutations. Once a record is created/modified/removed all queries referencing this record get updated. For example, if your data is fetched using `useFind('notes', { query: { tag: 'ideas' } })` and you then patch some note with `patch({ tag: 'ideas' })` - the query will updated immediately and rerender all components referencing that query. Adjust behaviour per query:

- `merge` - merge realtime events into cached queries as they come (default)
- `refetch` - refetch data for this query from the server when a realtime event is received
- `disabled` - ignore realtime events for this query

### Fetch policies

Fetch policies allow you to fine tune Figbird to your requirements. With the default `swr` (stale-while-revalidate) Figbir's uses cached data when possible for maximum responsiveness, but refetches in the background on mount to make sure data is up to date. The other policies are `cache-first` which will use cache and not refresh from the server (compatible with realtime)

- `swr` - show cached data if possible and refetch in the background (default)
- `cache-first` - show cached data if possible and avoid fetching if data is there
- `network-only` - always refetch data on mount

### Cache eviction

The usage of `useGet` and `useFind` hooks gets reference counted so that Figbird knows exactly if any of the queries are still being referenced by the UI. By default, Figbird will keep all the data and cache without ever evicting, but if your application demands it, you can strategically implement cache eviction hooks (e.g. on page navigation) to clear out all unused cache items or specific items based on service name or data attributes. (Note: yet to be implemnted)

- `manual` - cache all queries in memory forever, evict manually (default)
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
- [ ] global `realtime` option
- [ ] global `fetchPolicy` option
- [ ] global `cacheEviction` option

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
