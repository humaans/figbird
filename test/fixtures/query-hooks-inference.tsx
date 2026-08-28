import {
  createHooks,
  createSchema,
  defineQuery,
  service,
  useQueries,
  useQuery,
  useQueryResult,
  useQueryResults,
} from '../../lib'

interface Issue {
  id: number
  title: string
  creatorId: number
}

interface User {
  id: number
  name: string
}

const schema = createSchema({
  services: {
    issues: service<{ item: Issue }>(),
    users: service<{ item: User }>(),
  },
  relationships: {
    issues: ({ one }) => ({
      creator: one({ sourceField: 'creatorId', destService: 'users' }),
    }),
  },
})

const hooks = createHooks(schema)
const issueDetail = defineQuery(({ id }: { id: number }) =>
  hooks.q.issues.get(id).related('creator'),
)
const allIssues = defineQuery(() => hooks.q.issues.all())

/** Compile-time coverage for root and schema-bound data-first query hooks. */
export function QueryHooksInferenceFixture({ enabled }: { enabled: boolean }) {
  const rootFind: Issue[] = useQuery(hooks.q.issues)
  const boundFind: Issue[] = hooks.useQuery(hooks.q.issues.where({ title: 'Typed' }))
  const get: (Issue & { creator: User | null }) | null = hooks.useQuery(
    hooks.q.issues.get(1).related('creator'),
  )
  const all: Issue[] = hooks.useQuery(allIssues)
  const paginated: Issue[] = hooks.useQuery(hooks.q.issues.paginate({ pageSize: 25 }))

  const request = issueDetail({ id: 1 })
  const requestData: (Issue & { creator: User | null }) | null = hooks.useQuery(request)
  const nullableRequest: typeof request | null = enabled ? request : null
  const nullableData: (Issue & { creator: User | null }) | null | undefined =
    hooks.useQuery(nullableRequest)
  const skipped: Issue[] | undefined = hooks.useQuery(hooks.q.issues, { skip: enabled })

  const nonSuspense = useQueryResult(hooks.q.issues, { suspense: false })
  if (nonSuspense.status === 'success') {
    const narrowed: Issue[] = nonSuspense.data
    void narrowed
  }

  const paginationResult = hooks.useQueryResult(
    hooks.q.issues.paginate({ pageSize: 25, includeTotal: true }),
  )
  paginationResult.loadMore()
  const total: number | undefined = paginationResult.total

  const [parallelIssues, parallelUser]: [Issue[], User | null] = useQueries([
    hooks.q.issues,
    hooks.q.users.get(1),
  ])
  const [issuesResult, userResult] = useQueryResults([hooks.q.issues, hooks.q.users.get(1)])
  const resultIssues: Issue[] = issuesResult.data
  const resultUser: User | null = userResult.data

  const boundParallel: [Issue[], User[]] = hooks.useQueries([hooks.q.issues, hooks.q.users])
  const boundResults = hooks.useQueryResults([hooks.q.issues, hooks.q.users])
  const boundResultUsers: User[] = boundResults[1].data

  // @ts-expect-error useQuery is always Suspense-based and cannot represent loading or errors.
  useQuery(hooks.q.issues, { suspense: false })
  // @ts-expect-error Pagination controls belong to useQueryResult.
  paginated.loadMore()

  void rootFind
  void boundFind
  void get
  void all
  void requestData
  void nullableData
  void skipped
  void total
  void parallelIssues
  void parallelUser
  void resultIssues
  void resultUser
  void boundParallel
  void boundResultUsers
  return null
}
