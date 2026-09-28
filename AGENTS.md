Figbird is a library that provides effortless realtime data management for React + Feathers applications. It's a data fetching library that caches the data and ingest realtime events to update the cache.

When updating the code, use the following after updates:
* `npm run tsc` to type check
* `npm run lint` to lint (oxlint)
* `npm run ava` to run the tests
* `npm run test` to run the full test suite including all of the above

Since this is a library, we typically avoid using `any` at all. If the code produces the `Unexpected any` lint error, fix those by using better types. In some rare cases it does make sense to use any if that makes the public API of the library or a test implementation simpler - add an `oxlint-disable-next-line` comment in those cases.

Update tests if needed to make them work with the updated code.
Bug fixes come with one focused regression test that fails without the fix. Otherwise don't add tests unless explicitly asked for that task - otherwise we'll accumulate too many noisy tests.
