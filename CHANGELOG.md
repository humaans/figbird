# Figbird Changelog

## 0.5.2

- Fix an issue with disposing the realtime event listeners. Previously, realtime event listeners were not always being disposed of, depending on the order in which components were rendered and unrendered.
- Fix an issue where updating the query in `useFind` call would put the `useFind` into incorrect state with data `null` and loading `false`. Now, in such situations, `loading` (and `reloading`) will be set to true to correctly indicate that updated query is not cached and data is being fetched.

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
