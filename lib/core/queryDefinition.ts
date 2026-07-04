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

/**
 * An args-keyed query factory produced by `defineQuery`. Definitions are inert — they
 * hold no cache state and no instance dependency. The cache key is derived from the
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
  /** Optional label for errors/devtools — empty string when unnamed. Never identity. */
  readonly name: string
  build(args: Args): B
  validate(args: unknown): Args
}

/**
 * Trailing parameters for definition-consuming APIs (`prepare`, `prefetch`,
 * `useQuery`): `args` is required when the definition's build function declares them;
 * zero-arg definitions (`QueryDefinition<void, B>`) skip the args slot entirely, so
 * options come second-positionally — `useQuery(def, { suspense: false })`, no middle
 * `undefined`.
 */
export type ArgsAndOptions<Args, Options> = [Args] extends [void]
  ? [options?: Options]
  : [args: Args, options?: Options]

/**
 * Like `ArgsAndOptions`, but the options are required — used by overloads that
 * discriminate on an option literal (e.g. `{ suspense: false }`).
 */
export type ArgsAndRequiredOptions<Args, Options> = [Args] extends [void]
  ? [options: Options]
  : [args: Args, options: Options]

/**
 * Runtime companion to `ArgsAndOptions`: split a definition call's trailing values
 * into args and options. A definition whose build function declares no parameters
 * takes options in the first slot; the legacy `(undefined, options)` spelling is
 * tolerated. @internal
 */
export function splitDefinitionRest<Options>(
  definition: QueryDefinition<unknown, unknown>,
  first: unknown,
  second: unknown,
): { args: unknown; options: Options | undefined } {
  if (definition.build.length === 0) {
    return { args: undefined, options: (first ?? second) as Options | undefined }
  }
  return { args: first, options: second as Options | undefined }
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
 * Create a named, args-keyed query factory. Definitions are inert, pure values — they
 * hold no cache state and are not tied to a Figbird instance; identity comes from the
 * built builder's AST hash. Prefer the schema-typed `defineQuery` returned by
 * `createHooks(figbird)` in app code; this standalone export serves core-only and
 * non-React consumers.
 *
 * Args are typed from the build function. Pass a Standard Schema validator before the
 * build function when args arrive from untrusted sources (URL params, storage) — it
 * runs at every `prepare()`/`useQuery()` call site and throws `QueryArgsError`.
 *
 * The name is optional metadata, never identity (identity is the AST hash): it labels
 * `QueryArgsError` messages and devtools. Skip it unless you want those labels.
 *
 * A zero-param build produces a `QueryDefinition<void, B>`, whose consumers
 * (`prepare`, `prefetch`, `useQuery`) may omit the `args` argument entirely.
 */
export function defineQuery<B>(build: () => B): QueryDefinition<void, B>
export function defineQuery<Args, B>(build: (args: Args) => B): QueryDefinition<Args, B>
export function defineQuery<TSchema extends StandardSchemaV1, B>(
  argsSchema: TSchema,
  build: (args: StandardSchemaV1.InferOutput<TSchema>) => B,
): QueryDefinition<StandardSchemaV1.InferOutput<TSchema>, B>
export function defineQuery<B>(name: string, build: () => B): QueryDefinition<void, B>
export function defineQuery<Args, B>(
  name: string,
  build: (args: Args) => B,
): QueryDefinition<Args, B>
export function defineQuery<TSchema extends StandardSchemaV1, B>(
  name: string,
  argsSchema: TSchema,
  build: (args: StandardSchemaV1.InferOutput<TSchema>) => B,
): QueryDefinition<StandardSchemaV1.InferOutput<TSchema>, B>
export function defineQuery(
  a: string | StandardSchemaV1 | ((args: unknown) => unknown),
  b?: StandardSchemaV1 | ((args: unknown) => unknown),
  c?: (args: unknown) => unknown,
): QueryDefinition<unknown, unknown> {
  const name = typeof a === 'string' ? a : ''
  const [x, y] = typeof a === 'string' ? [b, c] : [a, b]
  const argsSchema = y ? (x as StandardSchemaV1) : null
  const build = (y ?? x) as (args: unknown) => unknown
  return {
    [QUERY_DEFINITION_BRAND]: true,
    name,
    build,
    validate: argsSchema
      ? (args: unknown) => validateQueryArgs(name || '(anonymous)', argsSchema, args)
      : (args: unknown) => args,
  }
}

/**
 * Handle returned by `figbird.prepare(definition, args)` — an explicit lease on a
 * query. `promise` resolves when the data is ready (rejects with what a Suspense read
 * would throw); `release()` drops the pin that keeps the underlying ref alive — when
 * no other subscriber remains, the ref tears down and the cache entry is evicted.
 *
 * Routers commonly attach their own metadata (e.g. a blocking/deferred priority) by
 * spreading: `{ ...figbird.prepare(def, args), priority: 'route' }` — that vocabulary
 * belongs to the router, not to figbird.
 */
export interface PreparedQuery {
  readonly key: string
  readonly promise: Promise<void>
  release(): void
}
