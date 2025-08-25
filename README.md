# Figbird

Effortless realtime data management for React + Feathers applications. Used in [Humaans](https://humaans.io/).

## Features

### Idiomatic React Hooks

Fetch some data with `const { data } = useFind('notes')` and your components will rerender in realtime as the data changes upstream. Modify the data using the `const { patch } = useMutation('notes')` and the upates will be instantly propagated to all components referencing the same objects.

- `useGet`
- `useFind`
- `useMutation`

### Typed Metadata

Figbird now provides full TypeScript support for adapter-specific metadata. When using the FeathersAdapter, pagination metadata like `total`, `limit`, and `skip` are automatically typed:

```typescript
const { data, meta } = useFind('todos')
// meta.total is typed as number | undefined
// meta.limit is typed as number | undefined  
// meta.skip is typed as number | undefined
```

Create hooks with your adapter's meta type for full IntelliSense support:

```typescript
import { createHooks, FeathersAdapter } from 'figbird'
import type { FeathersFindMeta } from 'figbird'

// Create typed hooks with FeathersFindMeta
const { useFind, useGet } = createHooks<MySchema, FeathersFindMeta>()
```

This feature is adapter-agnostic - custom adapters can provide their own metadata types for cursor-based pagination or other patterns.

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

## Install

    $ npm install figbird

## API Reference

Visit the [documentation site](https://humaans.github.io/figbird/) for full API reference.
