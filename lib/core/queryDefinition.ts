/**
 * Query definitions — args-keyed query factories produced by `defineQuery(build)`
 * (optionally with a name and/or a Standard Schema validator) and consumed by
 * `prepare`, `prefetch`, and `useQuery`.
 */

/**
 * Brand symbol used to identify `QueryDefinition` values at runtime.
 * Exported so other packages (router resolvers, devtools) can recognise definitions
 * without depending on the constructor surface.
 */
export const QUERY_DEFINITION_BRAND: unique symbol = Symbol.for('figbird.queryDefinition')
export const QUERY_REQUEST_BRAND: unique symbol = Symbol.for('figbird.queryRequest')

interface QueryDefinitionCore<Args, B> {
  readonly [QUERY_DEFINITION_BRAND]: true
  /** Optional label for errors/devtools — empty string when unnamed. Never identity. */
  readonly name: string
  build(args: Args): B
  validate(args: unknown): Args
}

/**
 * A concrete query definition with validated, normalized arguments. Requests are
 * inert and instance-independent, so routers can carry them as opaque route data.
 */
export interface QueryRequest<Args, B> {
  readonly [QUERY_REQUEST_BRAND]: true
  /** The originating definition's input is already bound and therefore hidden. */
  readonly definition: QueryDefinitionCore<Args, B>
  readonly args: Args
}

/**
 * An args-keyed query factory produced by `defineQuery`. Definitions are inert — they
 * hold no cache state and no instance dependency. The cache key is derived from the
 * underlying builder's AST hash, which means `prepare(def(args))` and
 * `useQuery(def(args))` collapse to the same `RelationalQueryRef`.
 *
 * Calling the definition validates at the binding site and returns an inert request.
 * Validation throws `QueryArgsError` on failure; on success the (possibly normalized)
 * value feeds into `build`, so the cache key reflects normalized args rather than raw input.
 */
export interface QueryDefinition<Args, B, Input = Args> extends QueryDefinitionCore<Args, B> {
  /** Validate and bind args into an inert request accepted by query consumers. */
  (args: Input): QueryRequest<Args, B>
}

/**
 * Every query shape accepted by Figbird's read APIs: a builder, a bound request,
 * or an argumentless definition. Adapter packages can depend on this contract
 * without reproducing Figbird's input union.
 */
export type QueryInput<B, Args = unknown> =
  | B
  | QueryRequest<Args, B>
  | QueryDefinition<void, B, void>

/** Extract the underlying builder from any supported query input. */
export type QueryInputBuilder<T> =
  T extends QueryRequest<unknown, infer B>
    ? B
    : T extends QueryDefinition<void, infer B, void>
      ? B
      : T

/**
 * Type guard for `QueryDefinition`. Useful in router prepare resolvers and overloaded
 * hook signatures that accept either a definition or a builder.
 */
export function isQueryDefinition(
  value: unknown,
): value is QueryDefinition<unknown, unknown, never> {
  return (
    typeof value === 'function' &&
    (value as { [QUERY_DEFINITION_BRAND]?: unknown })[QUERY_DEFINITION_BRAND] === true
  )
}

/** Type guard for a concrete query produced by calling a query definition. */
export function isQueryRequest(value: unknown): value is QueryRequest<unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [QUERY_REQUEST_BRAND]?: unknown })[QUERY_REQUEST_BRAND] === true
  )
}

interface ResolvedQueryInput<B> {
  builder: B
  name: string | undefined
}

/** Resolve every public query input through one runtime path. @internal */
export function resolveQueryInput<Args, B>(input: QueryInput<B, Args>): ResolvedQueryInput<B> {
  if (isQueryRequest(input)) {
    // The runtime brand proves the shape; retain the caller's generic builder and args.
    const request = input as QueryRequest<Args, B>
    return {
      builder: request.definition.build(request.args),
      name: request.definition.name,
    }
  }
  if (isQueryDefinition(input)) {
    // Only argumentless definitions are members of QueryInput.
    const definition = input as QueryDefinition<void, B, void>
    return {
      builder: definition.build(definition.validate(undefined)),
      name: definition.name,
    }
  }
  return { builder: input as B, name: undefined }
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

// Companion namespace — `import type` consumers can read InferInput / InferOutput / Result / Issue.
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
  export type InferInput<S extends StandardSchemaV1> =
    S extends StandardSchemaV1<infer Input, unknown> ? Input : never
  export type InferOutput<S extends StandardSchemaV1> =
    S extends StandardSchemaV1<unknown, infer Output> ? Output : never
}

/**
 * Thrown when a `QueryDefinition`'s `argsSchema` rejects the input passed to the
 * callable definition. Surfaces the definition name
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
 * Internal helper used when a callable definition binds its input into a request.
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
 * The `defineQuery` call surface — declared once and shared by the standalone export
 * (unconstrained builders) and the `createHooks` kit variant (builders bound to a
 * schema via `TBuilder`), so the two can never drift.
 */
export interface DefineQuery<TBuilder = unknown> {
  <B extends TBuilder>(build: () => B): QueryDefinition<void, B>
  <Args, B extends TBuilder>(build: (args: Args) => B): QueryDefinition<Args, B>
  <TSchema extends StandardSchemaV1, B extends TBuilder>(
    argsSchema: TSchema,
    build: (args: StandardSchemaV1.InferOutput<TSchema>) => B,
  ): QueryDefinition<StandardSchemaV1.InferOutput<TSchema>, B, StandardSchemaV1.InferInput<TSchema>>
  <B extends TBuilder>(name: string, build: () => B): QueryDefinition<void, B>
  <Args, B extends TBuilder>(name: string, build: (args: Args) => B): QueryDefinition<Args, B>
  <TSchema extends StandardSchemaV1, B extends TBuilder>(
    name: string,
    argsSchema: TSchema,
    build: (args: StandardSchemaV1.InferOutput<TSchema>) => B,
  ): QueryDefinition<StandardSchemaV1.InferOutput<TSchema>, B, StandardSchemaV1.InferInput<TSchema>>
}

/**
 * Create a named, args-keyed query factory. Definitions are inert, pure values — they
 * hold no cache state and are not tied to a Figbird instance; identity comes from the
 * built builder's AST hash. Prefer the schema-typed `defineQuery` returned by
 * `createHooks(schema)` in app code; this standalone export serves core-only and
 * non-React consumers.
 *
 * Without a schema, args are typed from the build function. With a Standard Schema,
 * the callable definition accepts its input type, while the build function receives
 * its validated output type. Validation runs when the definition binds a request and
 * throws `QueryArgsError`.
 *
 * The name is optional metadata, never identity (identity is the AST hash): it labels
 * `QueryArgsError` messages and devtools. Skip it unless you want those labels.
 *
 * A zero-param build produces a `QueryDefinition<void, B>` that consumers can use
 * directly without first binding a request.
 */
export const defineQuery: DefineQuery = ((
  a: string | StandardSchemaV1 | ((args: unknown) => unknown),
  b?: StandardSchemaV1 | ((args: unknown) => unknown),
  c?: (args: unknown) => unknown,
): QueryDefinition<unknown, unknown> => {
  const name = typeof a === 'string' ? a : ''
  const [x, y] = typeof a === 'string' ? [b, c] : [a, b]
  const argsSchema = y ? (x as StandardSchemaV1) : null
  const build = (y ?? x) as (args: unknown) => unknown
  const validate = argsSchema
    ? (args: unknown) => validateQueryArgs(name || '(anonymous)', argsSchema, args)
    : (args: unknown) => args
  let definition: QueryDefinition<unknown, unknown>
  definition = ((args: unknown) => ({
    [QUERY_REQUEST_BRAND]: true,
    definition,
    args: validate(args),
  })) as unknown as QueryDefinition<unknown, unknown>
  Object.defineProperties(definition, {
    [QUERY_DEFINITION_BRAND]: { value: true },
    name: { value: name, configurable: true },
    build: { value: build },
    validate: { value: validate },
  })
  return definition
}) as DefineQuery

/**
 * Handle returned by `figbird.prepare(definition(args))` — an explicit lease on a
 * query. `promise` resolves when the data is ready (rejects with what a Suspense read
 * would throw); `release()` drops the pin that keeps the underlying ref alive — when
 * no other subscriber remains, the ref tears down and the cache entry is evicted.
 *
 * Routers commonly attach their own metadata (e.g. a blocking/deferred priority) by
 * spreading: `{ ...figbird.prepare(def(args)), priority: 'route' }` — that vocabulary
 * belongs to the router, not to figbird.
 */
export interface PreparedQuery {
  readonly key: string
  readonly promise: Promise<void>
  release(): void
}
