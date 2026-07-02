/**
 * Named query definitions — args-keyed query factories produced by
 * `figbird.defineQuery(name, argsSchema, build)` and consumed by `figbird.prepare`
 * and `useQuery(definition, args)`.
 */

/**
 * Brand symbol used to identify `QueryDefinition` values at runtime.
 * Exported so other packages (router resolvers, devtools) can recognise definitions
 * without depending on the constructor surface.
 */
export const QUERY_DEFINITION_BRAND: unique symbol = Symbol.for('figbird.queryDefinition')

/**
 * A named, args-keyed query factory. Produced by `figbird.defineQuery(name, argsSchema, build)`.
 * Definitions are inert — they hold no cache state. The cache key is derived from the
 * underlying builder's AST hash, which means `prepare(def, args)` and `useQuery(def, args)`
 * collapse to the same `RelationalQueryRef`.
 *
 * `prepare` and `useQuery` run `validate` at the call site before invoking `build`.
 * Validation throws `QueryArgsError` on failure; on success the (possibly normalized)
 * value returned by `validate` is what feeds into `build`, so the cache key reflects
 * the normalized args rather than the raw input.
 */
export interface QueryDefinition<Args, B> {
  readonly [QUERY_DEFINITION_BRAND]: true
  readonly name: string
  build(args: Args): B
  validate(args: unknown): Args
}

/**
 * Type guard for `QueryDefinition`. Useful in router prepare resolvers and overloaded
 * hook signatures that accept either a definition or a builder.
 */
export function isQueryDefinition(value: unknown): value is QueryDefinition<unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [QUERY_DEFINITION_BRAND]?: unknown })[QUERY_DEFINITION_BRAND] === true
  )
}

/**
 * Subset of the [Standard Schema](https://github.com/standard-schema/standard-schema) v1
 * interface that figbird depends on. Any validator that implements this contract
 * (zod, valibot, arktype, etc.) can be passed as `argsSchema` to `defineQuery` —
 * figbird does not bundle a validator and stays validator-agnostic.
 *
 * `Output` defaults to `Input` so untransforming schemas don't need to specify both.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>
    readonly types?: { readonly input: Input; readonly output: Output }
  }
}

// Companion namespace — `import type` consumers can read InferOutput / Result / Issue.
// oxlint-disable-next-line @typescript-eslint/no-namespace
export namespace StandardSchemaV1 {
  export interface Issue {
    readonly message: string
    readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
  }
  export interface SuccessResult<Output> {
    readonly value: Output
    readonly issues?: undefined
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult
  export type InferOutput<S extends StandardSchemaV1> =
    S extends StandardSchemaV1<unknown, infer Output> ? Output : never
}

/**
 * Thrown when a `QueryDefinition`'s `argsSchema` rejects the args passed to
 * `figbird.prepare(def, args)` or `useQuery(def, args)`. Surfaces the definition name
 * (so error reporting tells you *which* query was misconfigured) plus the raw issues
 * the validator produced.
 *
 * Async validators are unsupported — figbird treats validation as a synchronous gate
 * at the call site. A schema whose `validate` returns a Promise also throws this
 * error with a single explanatory issue.
 */
export class QueryArgsError extends Error {
  readonly queryName: string
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>
  constructor(queryName: string, issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super(`Invalid args for query "${queryName}": ${formatStandardSchemaIssues(issues)}`)
    this.name = 'QueryArgsError'
    this.queryName = queryName
    this.issues = issues
  }
}

function formatStandardSchemaIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): string {
  if (issues.length === 0) return '(no issues reported)'
  return issues
    .map(issue => {
      const path = issue.path
        ? '.' +
          issue.path
            .map(seg => (typeof seg === 'object' && seg !== null ? String(seg.key) : String(seg)))
            .join('.')
        : ''
      return `${path || '(root)'}: ${issue.message}`
    })
    .join('; ')
}

/**
 * Run a Standard Schema's `validate` synchronously against `args`. Returns the
 * validated/normalized value, or throws `QueryArgsError` on failure or async result.
 * Internal helper — `prepare` and `useQuery` (definition + args overload) call it.
 */
export function validateQueryArgs<T>(
  queryName: string,
  schema: StandardSchemaV1<unknown, T>,
  args: unknown,
): T {
  const result = schema['~standard'].validate(args)
  if (result instanceof Promise) {
    throw new QueryArgsError(queryName, [
      {
        message: 'argsSchema returned a Promise; figbird only supports synchronous validators',
      },
    ])
  }
  if (result.issues) {
    throw new QueryArgsError(queryName, result.issues)
  }
  return result.value
}

/**
 * Handle returned by `figbird.prepare(definition, args)`. The router awaits `promise`
 * for `priority: 'route'` entries before committing the navigation; `priority: 'defer'`
 * entries are awaited inside Suspense boundaries on the destination screen instead.
 *
 * Calling `release()` drops the pin that keeps the underlying ref alive — when no other
 * subscriber remains, the ref tears down and the cache entry is evicted.
 */
export interface PreparedQuery {
  readonly key: string
  readonly priority: 'route' | 'defer'
  readonly promise: Promise<void>
  release(): void
}
