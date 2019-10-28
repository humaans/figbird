# Figbird Changelog

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
