import {
  createHooks,
  createSchema,
  Figbird,
  FeathersAdapter,
  service,
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
      methods: {
        getCheck: (
          input: { id: number; jobId: string },
          options?: { verbose: boolean },
        ) => Promise<Status>
        count: () => Promise<number>
        empty: () => Promise<null>
      }
    }>(),
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
