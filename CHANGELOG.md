# Figbird Changelog

## 0.13.0

- Switch from `tiny-atom` to `kinfolk` as the cache store. Breaking change if you're relying on using the cache directly.
- Remove the deprecated `loading: boolean` and `reloading: boolean` from `useFind` and `useGet` result - use `status: string` and `isFetching: boolean` instead.

## 0.12.2

- Upgrade all dependencies to address security alerts.

## 0.12.1

- Upgrade all dependencies to address security alerts.

## 0.12.0

- Upgrade all dependencies.
- Replace babel with swc.

## 0.11.1

- Fix an issue with `parallel: true` where it wasn't always fetching the last page of data.

## 0.11.0

- Add `parallel: true` option to useFind to use in combination with `allPages: true` that fetches all pages (after the 1st one) in parallel, resulting in faster page loads for when multiple pages need to be fetched.

## 0.10.1

- Fix: when skip is set to `true`, return data as `null` even if there's cached data available.

## 0.10.0

- Add support for multi remove, in addition to multi create.

## 0.9.0

- Add support for multi operations. E.g. multi create result, which is an array, now gets correctly incorporated into the cache.

## 0.8.1

- Do not dispatch mutation `success` / `error` if the component is unmounted
- Upgrade all dependencies

## 0.8.0

- The return values of `useGet`, `useFind` and `useMutation` are now wrapped in `useMemo`. This means they don't change between renders unless some of the keys changed.
- Functions `create`, `update`, `patch`, `remove` are now wrapped in `useCallback`. This means they don't change between renders.

## 0.7.1

- Fix bad `packafge.json#main` field.

## 0.7.0

No breaking changes! But some things have been deprecated and new options have been added.

- Add `fetchPolicy` option to `useGet` and `useFind`:
  - `swr` - show cached data if possible and refetch in the background
  - `cache-first` - show cached data if possible without refetching
  - `network-only` - always refetch the data on mount
- Add `realtime` option to `useGet` and `useFind`:
  - `merge` - merge realtime events into cached queries as they come
  - `refetch` - refetch the query when realtime event is received
  - `disabled` - do not update cached data on realtime events
- Add `status` and `isFetching` that supersedes `loading` and `reloading` boolean flags, which are still there but are now deprecated. For `useGet/useFind` status can be one of `loading | success | error` and for `useMutation` it's `idle | loading | success | error`
- Add `data` in `useMutation` return value, which holds the result of last successful mutation
- Log a warning if an item doesn't have an ID to help identify a misconfigured `idField`
- Add `matcher` option to `useGet` and `useFind` for customising how objects get matched against queries, e.g. useful if you use a custom filter or operation and want to handle that correctly client side
- Remove dependency on `@feathersjs/adapter-commons` reducing the bundle size

## 0.6.0

- Add new option `updatedAtField`, similar to `idField` it is used to extract the `updatedAt` value of an entity to know if the entity is newer or older than what's in the cache. This is to avoid overwriting older data with newer data when a get request is racing with a realtime update.
- Fix an issue with disposing the realtime event listeners. Previously, realtime event listeners were not always being disposed of, depending on the order in which components were rendered and unrendered.
- Fix an issue where updating the query in `useFind` call would put the `useFind` into incorrect state with data `null` and loading `false`. Now, in such situations, `loading` (and `reloading`) will be set to true to correctly indicate that updated query is not cached and data is being fetched.
- Fix error `useGet` and `useFind` error handling

## 0.5.1

- Fix an issue with removing realtime event listeners, chaining `.off()` doesn't work in Feathers (See https://github.com/feathersjs/feathers/issues/1704). This meant that when component with `useFind` was rendered in and out multiple times, the realtime event listeners were never being removed.

## 0.5.0

- Add `allPages` option to fetch all pages of the given resource
- Reuse in flight requests when identical (same id for get and same params hash for find)

## 0.4.0

- Add `refetch` in `useFind` and `useGet` to allow imperatively reloading the data

## 0.3.3

- Add dependencies to `useSelector`, otherwise wrong old closed over params are used. This meant that if say you change query, the old `hashedQuery` id was being used, returning wrong data in `useFind`

## 0.3.2

- Fix mutations from failing when no query object is used

## 0.3.1

- Fix `skip` option - do not fetch data when skip option is passed in to `useFind` or `useGet`

## 0.3.0

- Add `idField` option to Provider. By default look for both `id` and then `_id` - both common in Feathers applications.

## 0.2.0

- Improve realtime event listeners to work with multiple components using the same service. Previously, as soon as the component unmounts, we'd stop listening. Now, the realtime event listeners will remain active while there's at least one component connected to the given service.
- Do not add entities to cache from `created` events if they're note relevant to any queries. This avoids server events growing the cache size without any benefit to the client.

## 0.1.0

- Figbird hatched 🐣. Fully functional first version of the library.
