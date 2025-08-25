Figbird is a library that provides effortless realtime data management for React + Feathers applications. It's a data fetching library that caches the data and ingest realtime events to update the cache.

When updating the code, use the following after updates:
* `npm run tsc` to type check
* `npm run lint` to eslint
* `npm run ava` to run the tests
* `npm run test` to run the full test suite including all of the above

Since this is a library, we typically avoid using `any` at all. If the code produces the `Unexpected any` eslint error, fix those by using better types. In some rare cases it does make sense to use any if that makes the public API of the library or a test implementation simpler - add eslint ignore rule in those cases.
