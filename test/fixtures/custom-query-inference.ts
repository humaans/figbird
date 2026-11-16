import {
  createHooks,
  createSchema,
  Figbird,
  FeathersAdapter,
  service,
  query,
  type FeathersClient,
} from '../../lib'

interface Status {
  stage: 'queued' | 'done'
  progress: number
}
const schema = createSchema({
  services: {
    jobs: service<{
      item: { id: number; name: string }
      methods: { retry: (id: number) => Promise<Status> }
    }>().queries({
      getCheck:
        query<
          (input: { id: number; jobId: string }, options?: { verbose: boolean }) => Promise<Status>
        >(),
      count: query<() => Promise<number>>(),
      empty: query<() => Promise<null>>(),
    }),
  },
})
const figbird = new Figbird({ schema, adapter: new FeathersAdapter({} as FeathersClient) })
const { q, useQuery, useQueryResult, useQueries, useQueryResults, defineQuery } =
  createHooks(schema)
const custom = q.jobs.getCheck({ id: 1, jobId: 'job' })
const data = useQuery(custom)
const count = useQuery(q.jobs.count())
const empty = useQuery(q.jobs.empty())
const request = defineQuery((jobId: string) => q.jobs.getCheck({ id: 1, jobId }))
const fromRequest = useQuery(request('job'))
const tagged = useQueryResult(custom, { suspense: false })
const result = useQueryResult(custom)
const parallel = useQueries([q.jobs.get(1), custom, q.jobs.count()])
const results = useQueryResults([custom, q.jobs.count()])
export type CustomData = typeof data
export type CountData = typeof count
export type NullData = typeof empty
export type RequestData = typeof fromRequest
export type CustomArgs = Parameters<typeof q.jobs.getCheck>
export const typed: Status = data
export const typedRequest: Status = fromRequest
export const typedResult: Status = result.data
export const typedParallel: [Status, number] = [parallel[1], parallel[2]]
export const typedResults: Status = results[0].data
if (tagged.status === 'success') {
  const status: Status = tagged.data
  void status
}
const ref = figbird.query(custom)
// @ts-expect-error - custom results do not support pagination
ref.loadMore()
const snapshot = ref.getSnapshot()
if (snapshot.status === 'success') {
  const status: Status = snapshot.data
  void status
}
figbird.prepare(request('job'))
figbird.prefetch(custom)
figbird.explain(custom)
// @ts-expect-error - unknown schema service
q.unknown.getCheck()
// @ts-expect-error - unknown method
q.jobs.unknownMethod()
// @ts-expect-error - wrong tuple
q.jobs.getCheck(1)
// @ts-expect-error - missing required argument
q.jobs.getCheck()
// @ts-expect-error - no appended Figbird options
q.jobs.getCheck({ id: 1, jobId: 'job' }, undefined, { retry: false })
// @ts-expect-error - optional argument type preserved
q.jobs.getCheck({ id: 1, jobId: 'job' }, { verbose: 'yes' })
// @ts-expect-error - arbitrary custom results do not expose entity relations
custom.related('anything')
// @ts-expect-error - arbitrary custom results do not expose entity filters
custom.where({ stage: 'done' })
// @ts-expect-error - custom results are not entity item arrays
export const wrong: { id: number }[] = data
// @ts-expect-error - r is not part of the public API
export const removedReadProxy = figbird.r

// @ts-expect-error - writes are not reads
q.jobs.retry(1)
// @ts-expect-error - declared reads are not mutation methods
figbird.m.jobs.getCheck({ id: 1, jobId: 'job' })
figbird.m.jobs.retry(1)
// @ts-expect-error - query markers carry callable method types
query<string>()

// @ts-expect-error - zero-argument reads are not mutation methods either
figbird.m.jobs.count()

const replaced = createHooks(
  createSchema({
    services: {
      jobs: service<{ item: { id: number } }>()
        .queries({ first: query<() => Promise<string>>() })
        .queries({ second: query<() => Promise<number>>() }),
    },
  }),
)
export const replacementData: number = replaced.useQuery(replaced.q.jobs.second())
// @ts-expect-error - queries() replaces earlier declarations in the types too
replaced.q.jobs.first()

service<{ item: { id: number } }>().queries({
  // @ts-expect-error - a query cannot take a builder member's name
  where: query<() => Promise<number>>(),
})
service<{ item: { id: number } }>().queries({
  // @ts-expect-error - nor a name every object inherits
  toString: query<() => Promise<number>>(),
})
service<{ item: { id: number } }>()
  .at('api/items')
  // An ordinary name is accepted after at() as well.
  .queries({ summary: query<() => Promise<number>>() })
