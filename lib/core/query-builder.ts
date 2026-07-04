/**
 * Query builder for relational queries
 * Produces a Feathers-compatible AST that can be executed with relations
 */

import { hashObject } from './hash.js'
import type {
  Schema,
  ServiceNames,
  ServiceItem,
  ResolveRelatedItem,
  ResolveRelatedService,
} from './schema.js'

/**
 * Type-level: given a schema S and a service N, the set of relation names defined on
 * that service. Resolves to `never` when no relationships are declared for N.
 */
export type RelationNames<S extends Schema, N extends string> =
  S['relationships'] extends Record<string, Record<string, unknown>>
    ? N extends keyof S['relationships']
      ? keyof NonNullable<S['relationships']>[N] & string
      : never
    : never

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
  kind: 'find' | 'get' | 'paginate'
  resourceId?: string | number
  query: FeathersQuery
  cardinality: 'one' | 'many'
  related: Record<string, QueryAST>
  server?: boolean
  pageSize?: number
  returnTotal?: boolean
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
  kind: 'find' | 'get' | 'paginate'
  resourceId?: string | number
  query: FeathersQuery
  cardinality: 'one' | 'many'
  related: Record<string, QueryAST>
  server: boolean
  pageSize?: number
  returnTotal?: boolean
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
  TKind extends 'find' | 'get' | 'paginate' = 'find',
> {
  readonly #state: QueryBuilderState
  readonly #schema: S
  readonly #hash: string

  constructor(schema: S, service: string, state?: Partial<QueryBuilderState>) {
    this.#schema = schema
    this.#state = {
      service,
      kind: state?.kind ?? 'find',
      ...(state?.resourceId !== undefined ? { resourceId: state.resourceId } : {}),
      query: state?.query ?? {},
      cardinality: state?.cardinality ?? 'many',
      related: state?.related ?? {},
      server: state?.server ?? false,
      ...(state?.pageSize !== undefined ? { pageSize: state.pageSize } : {}),
      ...(state?.returnTotal !== undefined ? { returnTotal: state.returnTotal } : {}),
    }
    // Compute hash on construction for efficient change detection
    this.#hash = hashObject(this.#state)
  }

  /**
   * Returns the stable hash of this query (for React memoization)
   */
  hash(): string {
    return this.#hash
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

    if (this.#state.pageSize !== undefined) {
      ast.pageSize = this.#state.pageSize
    }

    if (this.#state.returnTotal) {
      ast.returnTotal = true
    }

    return ast
  }

  /**
   * Merge a Feathers query object into the current query
   * Multiple calls are deep-merged together
   */
  where(
    this: QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'>,
    query: WhereClause<TItem>,
  ): QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'> {
    return new QueryBuilder(this.#schema, this.#state.service, {
      ...this.#state,
      query: deepMerge(this.#state.query, query),
    })
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
   * Set cardinality to 'one' — the hook will return a single item (or null if no match).
   */
  one(
    this: QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'>,
  ): QueryBuilder<S, TService, TItem, TRelated, 'one', 'find'> {
    return new QueryBuilder(this.#schema, this.#state.service, {
      ...this.#state,
      cardinality: 'one',
    }) as QueryBuilder<S, TService, TItem, TRelated, 'one', 'find'>
  }

  /**
   * Fetch a single entity by primary key. The result is the item with any declared
   * relations attached, or the query enters an error state if the row does not exist
   * (mirroring `service.get(id)` semantics — distinct from `.where({ id }).one()`,
   * which resolves to `null` when no row matches).
   *
   * Only callable on a fresh service builder — `.where`/`.orderBy`/`.limit`/`.skip`/
   * `.server` are not meaningful for a primary-key lookup. `.related()` is, and can
   * be chained after `.get()`.
   */
  get(
    this: QueryBuilder<S, TService, TItem, TRelated, TCardinality, 'find'>,
    resourceId: string | number,
    // The reset TRelated must be `{}`, not `Record<string, never>` — the latter's
    // `keyof` is `string`, so a later `.related()` would `Omit` every field from
    // TItem (see the TRelated type-parameter comment on the class).
  ): QueryBuilder<S, TService, TItem, {}, 'one', 'get'> {
    return new QueryBuilder(this.#schema, this.#state.service, {
      kind: 'get',
      resourceId,
      query: {},
      cardinality: 'one',
      related: {},
      server: false,
    }) as QueryBuilder<S, TService, TItem, {}, 'one', 'get'>
  }

  /**
   * Switch this query into infinite-scroll / accumulator mode. The hook returns a
   * standard `data` array plus `loadMore()`, `hasMore`, `isLoadingMore`, and (when
   * `returnTotal: true`) a `totalCount` field. Each call to `loadMore()` appends the
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
    options: { pageSize: number; returnTotal?: boolean },
  ): QueryBuilder<S, TService, TItem, TRelated, 'many', 'paginate'> {
    if (!Number.isFinite(options.pageSize) || options.pageSize <= 0) {
      throw new Error(`paginate(): pageSize must be a positive number, got ${options.pageSize}`)
    }
    return new QueryBuilder(this.#schema, this.#state.service, {
      ...this.#state,
      kind: 'paginate',
      cardinality: 'many',
      pageSize: options.pageSize,
      ...(options.returnTotal !== undefined ? { returnTotal: options.returnTotal } : {}),
    }) as QueryBuilder<S, TService, TItem, TRelated, 'many', 'paginate'>
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
    // Look up the relationship definition from schema
    const relationships = this.#schema.relationships ?? {}
    const serviceRelations = relationships[this.#state.service]
    const relDef = serviceRelations?.[name]

    if (!relDef) {
      console.warn(
        `Relationship "${name}" not found for service "${this.#state.service}". ` +
          `Available relationships: ${serviceRelations ? Object.keys(serviceRelations).join(', ') : 'none'}`,
      )
    }

    // Create a builder for the related service
    const destService = relDef?.destService ?? name
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const relatedBuilder = new QueryBuilder<S, string, any>(this.#schema, destService)

    // Apply refinement if provided
    const refinedBuilder = refine ? refine(relatedBuilder) : relatedBuilder

    // Use the relationship's cardinality or the refined builder's cardinality.
    // 'embedded' is a relation-declaration concept (parent carries a list of ids); the
    // result shape is still an array, so it maps to 'many' on the AST.
    const relatedAST = refinedBuilder.toAST()
    if (relDef) {
      relatedAST.cardinality = relDef.cardinality === 'one' ? 'one' : 'many'
    }

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

  /**
   * Returns the schema this builder is associated with
   */
  getSchema(): S {
    return this.#schema
  }

  /**
   * Returns the service name for this query
   */
  getService(): string {
    return this.#state.service
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
    'find' | 'get' | 'paginate'
  >
    ? TCard extends 'one'
      ? MergeRelated<TItem, TRelated> | null
      : Array<MergeRelated<TItem, TRelated>>
    : never

/**
 * Type-level: extract the `kind` discriminator (`'find' | 'get' | 'paginate'`) of a
 * QueryBuilder. Used by hooks to widen their return shape for paginated queries.
 */
export type QueryBuilderKind<B> =
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  B extends QueryBuilder<Schema, string, any, any, any, infer K> ? K : never
