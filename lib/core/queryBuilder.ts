/**
 * Query builder for relational queries
 * Produces a Feathers-compatible AST that can be executed with relations
 */

import { hashObject } from './hash.js'
import type {
  Schema,
  ServiceNames,
  ServiceItem,
  ServiceRelationships,
  ResolveRelatedItem,
  ResolveRelatedService,
} from './schema.js'

/**
 * Type-level: given a schema S and a service N, the set of relation names defined on
 * that service. Resolves to `never` when no relationships are declared for N.
 */
export type RelationNames<S extends Schema, N extends string> = keyof ServiceRelationships<S, N> &
  string

/**
 * Feathers-style query object
 */
export type FeathersQuery = Record<string, unknown>

/** Feathers-style comparison operators for a field of type V. */
export interface FieldOperators<V> {
  $in?: V[]
  $nin?: V[]
  $lt?: V
  $lte?: V
  $gt?: V
  $gte?: V
  $ne?: V
  // Server-only / adapter-specific operators ($regex, $options, $like, ...) are
  // legal on any field — they just classify the query server-authoritative.
  [operator: `$${string}`]: unknown
}

/**
 * Filter object accepted by `.where()`: known item fields are typed (value or
 * comparison operators) for autocomplete and checking, while the open index
 * signature admits everything else that is legal but not statically known —
 * dotted relational paths (`'assignee.teamId'`), server-only operators
 * (`$regex`), `$or`, and dynamically-built filter objects.
 */
export type WhereClause<TItem> = {
  [K in keyof TItem & string]?: TItem[K] | FieldOperators<TItem[K]>
} & Record<string, unknown>

/**
 * Query AST that represents a query with optional relations.
 *
 * `kind: 'find'` runs an adapter `find()` (filtered/paginated list).
 * `kind: 'get'` runs an adapter `get(resourceId)` (primary-key lookup; `NotFound`
 * is surfaced as a query error rather than an empty result).
 * `kind: 'paginate'` runs a paged `find()` accumulator: the hook starts with the
 * first page, then `loadMore()` appends additional pages of `pageSize` rows.
 * `data` is the concatenated array across all loaded pages.
 */
export interface QueryAST {
  service: string
  kind: 'find' | 'get' | 'paginate' | 'all'
  resourceId?: string | number
  query: FeathersQuery
  cardinality: 'one' | 'many'
  related: Record<string, QueryAST>
  server?: boolean
  /** Point-in-time result: fetched once, untouched by realtime; refetch() only. */
  snapshot?: boolean
  pageSize?: number
  includeTotal?: boolean
}

/**
 * Deep merge two objects (for combining .where() calls)
 */
function deepMerge(target: FeathersQuery, source: FeathersQuery): FeathersQuery {
  const result: FeathersQuery = { ...target }

  for (const key of Object.keys(source)) {
    const sourceVal = source[key]
    const targetVal = result[key]

    if (
      typeof sourceVal === 'object' &&
      sourceVal !== null &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === 'object' &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      // Deep merge nested objects
      result[key] = deepMerge(targetVal as FeathersQuery, sourceVal as FeathersQuery)
    } else {
      // Overwrite with source value
      result[key] = sourceVal
    }
  }

  return result
}

/**
 * Internal state for building a query
 */
interface QueryBuilderState {
  service: string
  kind: 'find' | 'get' | 'paginate' | 'all'
  resourceId?: string | number
  query: FeathersQuery
  cardinality: 'one' | 'many'
  related: Record<string, QueryAST>
  server: boolean
  snapshot: boolean
  pageSize?: number
  includeTotal?: boolean
}

/**
 * QueryBuilder creates a fluent interface for building relational queries.
 * Each method returns a new QueryBuilder instance (immutable).
 *
 * @example
 * ```ts
 * const query = figbird.q.issues
 *   .where({ status: 'open' })
 *   .orderBy('createdAt', 'desc')
 *   .limit(50)
 *   .related('comments', c => c.limit(10))
 * ```
 */
export class QueryBuilder<
  S extends Schema,
  TService extends string = string,
  TItem = unknown,
  // `TRelated` accumulates declared relations. Default is `{}` (rather than
  // `Record<string, never>`) so `keyof TRelated` resolves to `never` until a relation is
  // declared — without that, `Omit<TItem, keyof TRelated>` would silently strip every
  // field from `TItem` because `Record<string, never>`'s `keyof` is `string`.
  TRelated extends object = {},
  TCardinality extends 'one' | 'many' = 'many',
  TKind extends 'find' | 'get' | 'paginate' | 'all' = 'find',
> {
  readonly #state: QueryBuilderState
  readonly #schema: S
  #hash: string | null = null

  // Two call-site shapes only: fresh builders (no state — the defaults literal) and
  // derivations (a complete next state). No partial mode: a call site that dropped
  // fields would silently reset them; requiring the full state makes that a compile
  // error instead.
  constructor(schema: S, service: string, state?: QueryBuilderState) {
    this.#schema = schema
    this.#state = state ?? {
      service,
      kind: 'find',
      query: {},
      cardinality: 'many',
      related: {},
      server: false,
      snapshot: false,
    }
  }

  /**
   * Returns the stable hash of this query (for React memoization). Computed lazily
   * and cached — `#state` never mutates after construction, and chained derivations
   * (`.where().orderBy()...`) would otherwise serialize every intermediate builder
   * whose hash is never read.
   */
  hash(): string {
    return (this.#hash ??= hashObject(this.#state))
  }

  /**
   * Returns the AST representation of this query
   */
  toAST(): QueryAST {
    const ast: QueryAST = {
      service: this.#state.service,
      kind: this.#state.kind,
      query: this.#state.query,
      cardinality: this.#state.cardinality,
      related: this.#state.related,
    }

    if (this.#state.resourceId !== undefined) {
      ast.resourceId = this.#state.resourceId
    }

    if (this.#state.server) {
      ast.server = true
    }

    if (this.#state.snapshot) {
      ast.snapshot = true
    }

    if (this.#state.pageSize !== undefined) {
      ast.pageSize = this.#state.pageSize
    }

    if (this.#state.includeTotal) {
      ast.includeTotal = true
    }

    return ast
  }

  /**
   * Merge a Feathers query object into the current query.
   * Multiple calls are deep-merged together.
   *
   * On a `find` builder these are the filter; on a `.get(id)` builder they ride
   * along as `params.query` to the get endpoint (rare conditions, `$select`, ...).
   */
  where<K extends 'find' | 'get'>(
    this: QueryBuilder<S, TService, TItem, TRelated, TCardinality, K>,
    query: WhereClause<TItem>,
  ): QueryBuilder<S, TService, TItem, TRelated, TCardinality, K> {
    return new QueryBuilder(this.#schema, this.#state.service, {
      ...this.#state,
      query: deepMerge(this.#state.query, query),
    }) as QueryBuilder<S, TService, TItem, TRelated, TCardinality, K>
  }

  /**
   * Add a sort clause
   * Multiple calls accumulate sort fields
   */
  orderBy(
    this: QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'>,
    // `(string & {})` keeps autocomplete for known item fields without rejecting
    // computed/server-side fields.
    // oxlint-disable-next-line @typescript-eslint/no-empty-object-type
    field: (keyof TItem & string) | (string & {}),
    direction: 'asc' | 'desc' = 'asc',
  ): QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'> {
    const currentSort = (this.#state.query.$sort as Record<string, number>) ?? {}
    return new QueryBuilder(this.#schema, this.#state.service, {
      ...this.#state,
      query: {
        ...this.#state.query,
        $sort: {
          ...currentSort,
          [field]: direction === 'asc' ? 1 : -1,
        },
      },
    })
  }

  /**
   * Set the query limit
   */
  limit(
    this: QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'>,
    n: number,
  ): QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'> {
    return new QueryBuilder(this.#schema, this.#state.service, {
      ...this.#state,
      query: {
        ...this.#state.query,
        $limit: n,
      },
    })
  }

  /**
   * Set the query skip/offset
   */
  skip(
    this: QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'>,
    n: number,
  ): QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'> {
    return new QueryBuilder(this.#schema, this.#state.service, {
      ...this.#state,
      query: {
        ...this.#state.query,
        $skip: n,
      },
    })
  }

  /**
   * Treat this query node as server-maintained.
   *
   * Use this when membership, ordering, or values depend on server-side logic that
   * cannot be proven locally. Realtime events from this service will refetch active
   * queries and mark inactive cached queries pending for the next subscription.
   */
  server(
    this: QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'>,
  ): QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'> {
    return new QueryBuilder(this.#schema, this.#state.service, {
      ...this.#state,
      server: true,
    })
  }

  /**
   * Freeze this query as a point-in-time result: it fetches once and then ignores
   * realtime entirely — no merges, no event-triggered refetches — for the root and
   * every relation under it. `refetch()` is the only way it moves. Snapshot-ness is
   * part of the query's identity: a frozen and a live read of the same filters do
   * not share a cache entry.
   *
   * Use for audit/export views, diff screens, or "results as of when you searched".
   */
  snapshot(
    this: QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'>,
  ): QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'> {
    return new QueryBuilder(this.#schema, this.#state.service, {
      ...this.#state,
      snapshot: true,
    })
  }

  /**
   * Fetch a single entity by primary key — `GET /:service/:id`. The result is the
   * item with any declared relations attached (typed `T | null`: a cold fetch of a
   * missing row enters the error state, mirroring `service.get(id)` semantics, while
   * realtime removal of the row nulls the data). For "the first match of a filter,
   * if any", use `.where(...).limit(1)` — the find-semantics spelling.
   *
   * Only callable on a fresh service builder. `.where()` may be chained after it —
   * the conditions ride along as `params.query` to the get endpoint — as may
   * `.related()`. Windowing/ordering (`.orderBy`/`.limit`/`.skip`) and `.server`/
   * `.snapshot` are find-only.
   */
  get(
    this: QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'>,
    resourceId: string | number,
    // The reset TRelated must be `{}`, not `Record<string, never>` — the latter's
    // `keyof` is `string`, so a later `.related()` would `Omit` every field from
    // TItem (see the TRelated type-parameter comment on the class).
  ): QueryBuilder<S, TService, TItem, {}, 'one', 'get'> {
    return new QueryBuilder(this.#schema, this.#state.service, {
      service: this.#state.service,
      kind: 'get',
      resourceId,
      query: {},
      cardinality: 'one',
      related: {},
      server: false,
      snapshot: false,
    }) as QueryBuilder<S, TService, TItem, {}, 'one', 'get'>
  }

  /**
   * Switch this query into infinite-scroll / accumulator mode. The hook returns a
   * standard `data` array plus `loadMore()`, `hasMore`, `isLoadingMore`, and (when
   * `includeTotal: true`) a `total` field. Each call to `loadMore()` appends the
   * next `pageSize` rows to `data`.
   *
   * Realtime events on the underlying service refetch the loaded pages — local merge
   * on a paginated/sorted window is unsafe (an inserted row might displace the page
   * boundary), so the source of truth stays the server. The store's batching window
   * coalesces bursts of events into a single refetch.
   *
   * Composable with `.where`, `.orderBy`, and `.related` (chain those *before* calling
   * `.paginate`). Once `.paginate` is applied, additional filtering/ordering builders
   * are blocked at the type level — call `.related()` afterwards if you need to attach
   * relations.
   */
  paginate(
    this: QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'>,
    options: { pageSize: number; includeTotal?: boolean },
  ): QueryBuilder<S, TService, TItem, TRelated, 'many', 'paginate'> {
    if (!Number.isInteger(options.pageSize) || options.pageSize <= 0) {
      throw new Error(`paginate(): pageSize must be a positive integer, got ${options.pageSize}`)
    }
    return new QueryBuilder(this.#schema, this.#state.service, {
      ...this.#state,
      kind: 'paginate',
      cardinality: 'many',
      pageSize: options.pageSize,
      ...(options.includeTotal !== undefined ? { includeTotal: options.includeTotal } : {}),
    }) as QueryBuilder<S, TService, TItem, TRelated, 'many', 'paginate'>
  }

  /**
   * Fetch every row matching this query — the exhaustive verb. All pages are
   * drained, so the server's default page cap never silently truncates the result,
   * and the query classifies local-exact (realtime events merge into the complete
   * set instead of triggering refetches).
   *
   * Unfiltered, it doubles as the reference-data preload (locations, currencies,
   * roles, policies): on success the service is marked *fully materialized*, and
   * any later matcher-decidable find against it — including sorted/limited
   * windows — is answered locally from the cache with no network roundtrip.
   *
   * Filtered (`.where(...).all()`), it fetches the complete slice. Completeness
   * holds for *this exact query* only — it does not materialize the service, and
   * narrower reads (a subset of the filter) are separate queries that fetch on
   * their own.
   *
   * Windowing contradicts "all": `.limit()`/`.skip()` cannot be combined with it
   * (use `.paginate()` for incremental loading). `.orderBy()` is fine — order
   * doesn't affect completeness. Chain `.where()`/`.orderBy()` *before* `.all()`;
   * `.related()` may be chained after to preload joined sets.
   *
   * The schema author is responsible for reaching for it only where the matching
   * row count is bounded. Typically paired with preparation at the app shell:
   * ```ts
   * prepare(defineQuery(() => q.locations.all()))
   * ```
   */
  all(
    this: QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'>,
  ): QueryBuilder<S, TService, TItem, TRelated, 'many', 'all'> {
    if ('$limit' in this.#state.query || '$skip' in this.#state.query) {
      throw new Error(
        'all(): cannot be combined with .limit()/.skip() — "all" fetches every matching row. ' +
          'Drop the window, or use .paginate() for incremental loading.',
      )
    }
    return new QueryBuilder(this.#schema, this.#state.service, {
      ...this.#state,
      kind: 'all',
      cardinality: 'many',
    }) as QueryBuilder<S, TService, TItem, TRelated, 'many', 'all'>
  }

  /**
   * Include a related entity/entities. The relation must exist on the schema — the
   * autocomplete suggests only names defined for this service, and the resulting item
   * type (including cardinality) is inferred automatically.
   *
   * @param name   - The name of the relation, as defined on the schema.
   * @param refine - Optional callback to refine the related query (e.g. add filters,
   *                 limits, nested relations).
   */
  related<
    RelName extends RelationNames<S, TService>,
    TRefinedRelated extends Record<string, unknown> = Record<string, never>,
  >(
    name: RelName,
    // Inner builder is typed over the destination service so that `c.related(...)` inside
    // the refine callback autocompletes to the destination's relations.
    refine?: (
      builder: QueryBuilder<
        S,
        ResolveRelatedService<S, TService, RelName>,
        ServiceItem<S, ResolveRelatedService<S, TService, RelName>>
      >,
    ) => QueryBuilder<
      S,
      ResolveRelatedService<S, TService, RelName>,
      ServiceItem<S, ResolveRelatedService<S, TService, RelName>>,
      TRefinedRelated,
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >,
  ): QueryBuilder<
    S,
    TService,
    TItem,
    TRelated & Record<RelName, ResolveRelatedItem<S, TService, RelName, TRefinedRelated>>,
    TCardinality,
    TKind
  > {
    // Look up the relationship definition from schema. The schema is fixed at
    // construction and typed callers can't get this wrong, so an unknown name is
    // always a bug in an untyped caller — fail fast at the call site instead of
    // building a plausible-but-empty relation the runtime would warn about again.
    const relationships = this.#schema.relationships ?? {}
    const serviceRelations = relationships[this.#state.service]
    const relDef = serviceRelations?.[name]
    if (!relDef) {
      throw new Error(
        `figbird: relationship "${name}" is not defined for service "${this.#state.service}". ` +
          `Available relationships: ${serviceRelations ? Object.keys(serviceRelations).join(', ') : 'none'}`,
      )
    }

    // Create a builder for the related service
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const relatedBuilder = new QueryBuilder<S, string, any>(this.#schema, relDef.destService)

    // Apply refinement if provided
    const refinedBuilder = refine ? refine(relatedBuilder) : relatedBuilder

    // Use the relationship's cardinality on the AST.
    // 'embedded' is a relation-declaration concept (parent carries a list of ids); the
    // result shape is still an array, so it maps to 'many' on the AST.
    const relatedAST = refinedBuilder.toAST()
    relatedAST.cardinality = relDef.cardinality === 'one' ? 'one' : 'many'

    return new QueryBuilder(this.#schema, this.#state.service, {
      ...this.#state,
      related: {
        ...this.#state.related,
        [name]: relatedAST,
      },
    }) as QueryBuilder<
      S,
      TService,
      TItem,
      TRelated & Record<RelName, ResolveRelatedItem<S, TService, RelName, TRefinedRelated>>,
      TCardinality,
      TKind
    >
  }
}

/**
 * Type for the query builder proxy that provides service accessors. Each accessor
 * threads the service name literal through so `.related()` can infer related item
 * types from the schema on the call site.
 */
export type QueryBuilderProxy<S extends Schema> = {
  <K extends ServiceNames<S>>(serviceName: K): QueryBuilder<S, K & string, ServiceItem<S, K>>
  (serviceName: string): QueryBuilder<S, string, unknown>
} & {
  [K in ServiceNames<S>]: QueryBuilder<S, K & string, ServiceItem<S, K>>
}

/**
 * Creates a proxy that generates QueryBuilder instances for each service
 */
export function createQueryBuilderProxy<S extends Schema>(schema: S): QueryBuilderProxy<S> {
  const create = (serviceName: string) => new QueryBuilder(schema, serviceName)

  return new Proxy(create as QueryBuilderProxy<S>, {
    apply(_, _thisArg, [serviceName]: [string]) {
      return create(serviceName)
    },
    get(target, serviceName: string | symbol) {
      if (typeof serviceName === 'symbol' || serviceName in target) {
        return Reflect.get(target, serviceName)
      }
      return create(serviceName)
    },
  })
}

/**
 * Merge declared relations into the base row, with relations *overriding* same-named
 * fields. This matters for `embed`, where the parent typically carries an id list under
 * the same key the relation expands into (e.g. `membersPreview: number[]` becomes
 * `membersPreview: Person[]` once `.related('membersPreview')` runs).
 *
 * Default `TRelated = {}` makes `keyof TRelated` resolve to `never`, so `Omit<TItem, never>`
 * preserves `TItem` verbatim. After one or more `.related()` calls, `keyof TRelated` is a
 * literal union and `Omit` strips only those keys from `TItem`.
 */
type MergeRelated<TItem, TRelated extends object> = Omit<TItem, keyof TRelated> & TRelated

/**
 * Type-level: extract the final assembled result type of a QueryBuilder, taking its
 * cardinality into account.
 *
 * - many → Array<MergeRelated<TItem, TRelated>>
 * - one  → MergeRelated<TItem, TRelated> | null
 */
export type QueryBuilderResult<B> =
  B extends QueryBuilder<
    Schema,
    string,
    infer TItem,
    infer TRelated,
    infer TCard,
    'find' | 'get' | 'paginate' | 'all'
  >
    ? TCard extends 'one'
      ? MergeRelated<TItem, TRelated> | null
      : Array<MergeRelated<TItem, TRelated>>
    : never

/**
 * Type-level: extract the `kind` discriminator (`'find' | 'get' | 'paginate' | 'all'`) of a
 * QueryBuilder. Used by hooks to widen their return shape for paginated queries.
 */
export type QueryBuilderKind<B> =
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  B extends QueryBuilder<Schema, string, any, any, any, infer K> ? K : never

/**
 * Any builder over schema S — the loose constraint for overload-dispatch seams,
 * where the public overloads carry the real types. Centralizes the `any` spread
 * so call sites don't each need a lint suppression. @internal
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyQueryBuilder<S extends Schema = any> = QueryBuilder<S, any, any, any, any, any>
