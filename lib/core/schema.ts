/**
 * Schema types for Figbird
 * These types enable type-safe service definitions and query inference
 */

// Unique symbol for phantom types - keeps internal typing machinery hidden
declare const $phantom: unique symbol

// Base service type definition interface that users provide
export interface ServiceTypeDefinition {
  item: unknown
  create?: unknown
  update?: unknown
  patch?: unknown
  query?: unknown
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  methods?: Record<string, (...args: any[]) => any>
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMethodsType = Record<string, (...args: any[]) => any>

/**
 * The fully-resolved shape a service's phantom slot carries: every payload present,
 * defaults already applied. `service<T>()` resolves a user-facing
 * `ServiceTypeDefinition` (optional fields) into this.
 */
export interface ResolvedServiceDef {
  item: unknown
  query: unknown
  create: unknown
  update: unknown
  patch: unknown
  methods: AnyMethodsType
}

// Internal service representation — the resolved definition lives in one phantom slot
export interface Service<
  TDef extends ResolvedServiceDef = ResolvedServiceDef,
  TName extends string = string,
> {
  readonly name: TName
  readonly path: string
  readonly [$phantom]?: TDef
}

export interface ServiceOptions<TPath extends string = string> {
  /**
   * Transport-level service name. When omitted, the schema key is used.
   *
   * This lets app code use ergonomic schema keys (`people`) while adapters still
   * call the real backend service path (`api/people`).
   */
  path?: TPath
}

// Helper types to derive payload types from service definition
type DeriveCreate<TServiceDef extends ServiceTypeDefinition> =
  TServiceDef['create'] extends undefined ? Partial<TServiceDef['item']> : TServiceDef['create']

type DeriveUpdate<TServiceDef extends ServiceTypeDefinition> =
  TServiceDef['update'] extends undefined ? TServiceDef['item'] : TServiceDef['update']

type DerivePatch<TServiceDef extends ServiceTypeDefinition> = TServiceDef['patch'] extends undefined
  ? Partial<TServiceDef['item']>
  : TServiceDef['patch']

type DeriveMethods<TServiceDef extends ServiceTypeDefinition> =
  TServiceDef['methods'] extends undefined
    ? Record<string, never>
    : NonNullable<TServiceDef['methods']> & AnyMethodsType

type DeriveQuery<TServiceDef extends ServiceTypeDefinition> = 'query' extends keyof TServiceDef
  ? Exclude<TServiceDef['query'], undefined>
  : Record<string, unknown>

/** Apply the payload defaults, turning a user definition into a resolved one. */
type ResolveDef<TServiceDef extends ServiceTypeDefinition> = {
  item: TServiceDef['item']
  query: DeriveQuery<TServiceDef>
  create: DeriveCreate<TServiceDef>
  update: DeriveUpdate<TServiceDef>
  patch: DerivePatch<TServiceDef>
  methods: DeriveMethods<TServiceDef>
}

// Phase 1: Create a service definition (no name yet)
export function service<
  TServiceDef extends ServiceTypeDefinition,
  const TPath extends string = string,
>(options: ServiceOptions<TPath> = {}): Service<ResolveDef<TServiceDef>> {
  return { name: '', path: options.path ?? '' } as Service<ResolveDef<TServiceDef>>
}

// Base schema interface - flexible to preserve specific service types
export interface Schema {
  services: Record<string, Service>
  relationships?: SchemaRelationships
}

/**
 * Type-level lookup: given schema S, service N, relation name R, and (optionally) a
 * set of nested relations already merged into the related item, resolve the final
 * assembled type wrapped in the relationship's cardinality.
 *
 * - `one`      → (RelItem & TNested) | null   (no match returns null at runtime)
 * - `many`     → Array<RelItem & TNested>
 * - `embedded` → Array<RelItem & TNested>     (ids embedded on the parent)
 *
 * TNested flows through from refine callbacks in `.related(name, c => c.related(...))`
 * so deeply-nested relations are reflected in the outer shape.
 */
export type ResolveRelatedItem<
  S extends Schema,
  N extends string,
  R extends string,
  TNested extends Record<string, unknown> = Record<string, never>,
> =
  S['relationships'] extends Record<string, Record<string, unknown>>
    ? N extends keyof S['relationships']
      ? R extends keyof NonNullable<S['relationships']>[N]
        ? // oxlint-disable-next-line @typescript-eslint/no-explicit-any
          NonNullable<S['relationships']>[N][R] extends RelationshipDef<infer TDest, infer TCard>
          ? TDest extends ServiceNames<S>
            ? TCard extends 'one'
              ? (ServiceItem<S, TDest> & TNested) | null
              : Array<ServiceItem<S, TDest> & TNested>
            : never
          : never
        : never
      : never
    : never

/**
 * Type-level lookup: extract the destination service name (as a literal) for a given
 * relation. Used by the query builder so refine callbacks get a correctly-typed inner
 * builder (e.g. `c => c.related(...)` — `c` is a builder over the destination service).
 */
export type ResolveRelatedService<S extends Schema, N extends string, R extends string> =
  S['relationships'] extends Record<string, Record<string, unknown>>
    ? N extends keyof S['relationships']
      ? R extends keyof NonNullable<S['relationships']>[N]
        ? // oxlint-disable-next-line @typescript-eslint/no-explicit-any
          NonNullable<S['relationships']>[N][R] extends RelationshipDef<infer TDest, any>
          ? TDest & ServiceNames<S>
          : never
        : never
      : never
    : never

/**
 * Relationship definition for connecting services.
 *
 * The destService and cardinality are generic so that `one({ destService: 'users', ... })`,
 * `many(...)`, and `embed(...)` preserve those as literal types in the schema. This is
 * what lets the query builder infer the related item type from the schema at the call site.
 *
 * Cardinality variants:
 * - `'one'`      — single related item, single-hop (`parent.sourceField → dest.destField`)
 *                  or chained through an intermediate service via `via`
 * - `'many'`     — array of related items, single-hop or two-hop (junction-table) via `via`
 * - `'embedded'` — array of related items where `parent.sourceField` is itself a list of
 *                  dest ids (a server-materialised preview field; bounded payload)
 */
export interface RelationshipDef<
  TDest extends string = string,
  TCardinality extends 'one' | 'many' | 'embedded' = 'one' | 'many' | 'embedded',
> {
  /**
   * Field on the side closer to the parent within the *current* hop.
   * - For single-hop relations: a field on the parent.
   * - For two-hop `many` (when `via` is set): a field on the junction (the FK pointing
   *   to the destination service).
   * - For `'embedded'`: a list-of-ids field on the parent.
   */
  sourceField: string[] // array for compound keys support
  destService: TDest
  destField: string[]
  cardinality: TCardinality
  query?: Record<string, unknown> // optional additional filter
  /**
   * First hop for two-hop relations — junction-table `many`, or a chained `one`
   * (parent → intermediate → destination). When present, `sourceField` /
   * `destService` / `destField` describe the second hop (intermediate → dest) and
   * `via` describes the first (parent → intermediate). Capped at two hops total.
   */
  via?: {
    sourceField: string[]
    destService: string
    destField: string[]
    query?: Record<string, unknown>
  }
}

/**
 * Map of relationships per service — the loose shape used by Figbird-agnostic code paths.
 * A concrete schema produced by createSchema narrows this further.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export type SchemaRelationships = Record<string, Record<string, RelationshipDef<any, any>>>

/**
 * Field reference on an item: a known field name, or an array of them for compound
 * keys. Untyped items (schema-less usage, the bare helper exports) fall back to
 * plain strings.
 */
type FieldsOf<TItem> = unknown extends TItem
  ? string | string[]
  : (keyof TItem & string) | (keyof TItem & string)[]

/**
 * Hop config — one segment of a relationship's traversal. For single-hop relations there's
 * just one of these; for two-hop `many` (junction tables) there are two.
 *
 * Fields accept a plain string for the common single-field case; arrays remain for
 * compound keys. `destField` defaults to `'id'`. When the source and destination item
 * types are known (inside createSchema's per-service relationship factories), both
 * field ends type-check against the actual items.
 */
export interface RelationshipHop<
  TDest extends string = string,
  TSourceItem = unknown,
  TDestItem = unknown,
> {
  sourceField: FieldsOf<TSourceItem>
  destService: TDest
  destField?: FieldsOf<TDestItem>
  query?: Record<string, unknown>
}

function toFieldArray(field: string | string[]): string[] {
  return Array.isArray(field) ? field : [field]
}

/** Normalize a hop's shorthand (string fields, defaulted destField) to the internal shape. */
function normalizeHop<TDest extends string>(
  hop: RelationshipHop<TDest>,
): RelationshipHop<TDest> & {
  sourceField: string[]
  destField: string[]
} {
  return {
    ...hop,
    sourceField: toFieldArray(hop.sourceField),
    destField: toFieldArray(hop.destField ?? 'id'),
  }
}

/**
 * Runtime implementation behind the scoped `one` factory helper. Only reachable
 * through a per-service relationships factory, which is what types every hop end.
 *
 * Two-hop form: `one(parentToIntermediate, intermediateToDest)` chains two lookups
 * into a single declared edge (person → current employment → job role). When
 * multiple intermediate rows match a parent, the first resolves — make the first
 * hop selective (an FK on the parent, or a hop `query` filter) so at most one does.
 */
function one<TDest extends string>(def: RelationshipHop<TDest>): RelationshipDef<TDest, 'one'>
function one<TJunction extends string, TDest extends string>(
  parentToJunction: RelationshipHop<TJunction>,
  junctionToDest: RelationshipHop<TDest>,
): RelationshipDef<TDest, 'one'>
function one(
  first: RelationshipHop<string>,
  second?: RelationshipHop<string>,
): RelationshipDef<string, 'one'> {
  if (!second) {
    return { ...normalizeHop(first), cardinality: 'one' }
  }
  return twoHop(first, second, 'one')
}

/**
 * Build a two-hop relationship: `via` holds the parent → intermediate hop, the top
 * level holds intermediate → destination. Shared by `one(hop1, hop2)` (chained
 * lookups, e.g. person → current employment → job role) and `many(hop1, hop2)`
 * (junction tables).
 */
function twoHop<TCardinality extends 'one' | 'many'>(
  first: RelationshipHop<string>,
  second: RelationshipHop<string>,
  cardinality: TCardinality,
): RelationshipDef<string, TCardinality> {
  const junctionHop = normalizeHop(first)
  const destHop = normalizeHop(second)
  return {
    sourceField: destHop.sourceField,
    destService: destHop.destService,
    destField: destHop.destField,
    cardinality,
    ...(destHop.query ? { query: destHop.query } : {}),
    via: {
      sourceField: junctionHop.sourceField,
      destService: junctionHop.destService,
      destField: junctionHop.destField,
      ...(junctionHop.query ? { query: junctionHop.query } : {}),
    },
  }
}

/**
 * Helper to define a one-to-many or many-to-many relationship.
 *
 * Single-hop: `many({ sourceField, destService, destField, query? })`.
 *
 * Two-hop (junction table): `many(parentToJunction, junctionToDest)` — the consumer of
 * `.related(name)` sees the destination items directly; the junction is hidden.
 * Capped at two hops, matching Zero. For deeper traversals, model an intermediate
 * relation explicitly or reach for `embed` if a server-materialised slice is enough.
 *
 * See `one` for how these are reached.
 */
function many<TDest extends string>(def: RelationshipHop<TDest>): RelationshipDef<TDest, 'many'>
function many<TJunction extends string, TDest extends string>(
  parentToJunction: RelationshipHop<TJunction>,
  junctionToDest: RelationshipHop<TDest>,
): RelationshipDef<TDest, 'many'>
function many(
  first: RelationshipHop<string>,
  second?: RelationshipHop<string>,
): RelationshipDef<string, 'many'> {
  if (!second) {
    return { ...normalizeHop(first), cardinality: 'many' }
  }
  return twoHop(first, second, 'many')
}

/**
 * Helper to define an "embedded" relationship — the parent record carries a list of
 * destination ids in `sourceField` (a server-materialised preview / denormalised edge
 * list). The runtime fans those ids into a single `IN (...)` query against `destField`
 * on the destination service, then assembles per-parent slices in JS.
 *
 * Use this for bounded previews ("top 5 members of each role") where the junction is
 * hidden and the slice is computed server-side. **It's only as fresh as the parent
 * record:** a child being created/updated does not invalidate `embed` results unless
 * the parent's id-list field is recomputed. For unbounded relations, use `many` (with
 * a second hop if there's a junction table).
 */
function embed<TDest extends string>(
  def: RelationshipHop<TDest>,
): RelationshipDef<TDest, 'embedded'> {
  return { ...normalizeHop(def), cardinality: 'embedded' }
}

/** Extract the item type carried by a Service value's phantom slot. */
type ServiceItemOf<S> = S extends Service<infer TDef, string> ? TDef['item'] : unknown

/**
 * Relationship helpers passed to a per-service relationships factory. Scoped to both
 * the service map and the source service, so every end of every hop type-checks:
 * `destService` is constrained to the schema's service names, `sourceField` to the
 * source item's fields, and `destField` to the destination item's fields — including
 * both hops of a junction `many`, where the second hop's source is the junction item.
 */
export interface RelationshipHelpers<TServices = Record<string, Service>, TSourceItem = unknown> {
  one: {
    <TDest extends keyof TServices & string>(
      def: RelationshipHop<TDest, TSourceItem, ServiceItemOf<TServices[TDest]>>,
    ): RelationshipDef<TDest, 'one'>
    <TJunction extends keyof TServices & string, TDest extends keyof TServices & string>(
      parentToJunction: RelationshipHop<
        TJunction,
        TSourceItem,
        ServiceItemOf<TServices[TJunction]>
      >,
      junctionToDest: RelationshipHop<
        TDest,
        ServiceItemOf<TServices[TJunction]>,
        ServiceItemOf<TServices[TDest]>
      >,
    ): RelationshipDef<TDest, 'one'>
  }
  many: {
    <TDest extends keyof TServices & string>(
      def: RelationshipHop<TDest, TSourceItem, ServiceItemOf<TServices[TDest]>>,
    ): RelationshipDef<TDest, 'many'>
    <TJunction extends keyof TServices & string, TDest extends keyof TServices & string>(
      parentToJunction: RelationshipHop<
        TJunction,
        TSourceItem,
        ServiceItemOf<TServices[TJunction]>
      >,
      junctionToDest: RelationshipHop<
        TDest,
        ServiceItemOf<TServices[TJunction]>,
        ServiceItemOf<TServices[TDest]>
      >,
    ): RelationshipDef<TDest, 'many'>
  }
  embed: <TDest extends keyof TServices & string>(
    def: RelationshipHop<TDest, TSourceItem, ServiceItemOf<TServices[TDest]>>,
  ) => RelationshipDef<TDest, 'embedded'>
}

/**
 * The relationships config: one factory per source service, each receiving helpers
 * scoped to that service. Keeping factories per service (rather than one global
 * callback) is what lets `sourceField` type-check — a global callback can't know
 * which service a `one()` call is declared under.
 */
export type RelationshipsConfig<TServiceMap> = {
  [K in keyof TServiceMap]?: (
    helpers: RelationshipHelpers<TServiceMap, ServiceItemOf<TServiceMap[K]>>,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Record<string, RelationshipDef<any, any>>
}

// Helper type to re-key a service with its literal schema name
type ExtractServiceWithName<S, N extends string> =
  S extends Service<infer TDef, string> ? Service<TDef, N> : never

// Phase 2: Create a schema with services object map (preserves literal keys + typed
// relationships so downstream hooks can infer related item types at call sites).
/** The relationships map a set of per-service factories resolves to. */
type ResolvedRelationships<TServiceMap, TRelFactories> = {
  [K in keyof TRelFactories & keyof TServiceMap]: TRelFactories[K] extends (
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    ...args: any[]
  ) => infer R
    ? R
    : never
}

export function createSchema<
  const TServiceMap extends Record<string, Service>,
  const TRelFactories extends RelationshipsConfig<TServiceMap> = {},
>(config: {
  services: TServiceMap
  // The intersection is the standard contextual-typing trick: TRelFactories infers
  // the precise per-service return types from the value, while the
  // RelationshipsConfig member supplies the scoped helper parameter types to each
  // callback (inference alone would leave the params implicitly `any`).
  relationships?: TRelFactories & RelationshipsConfig<TServiceMap>
}): {
  services: {
    readonly [K in keyof TServiceMap]: ExtractServiceWithName<TServiceMap[K], K & string>
  }
  relationships: ResolvedRelationships<TServiceMap, TRelFactories>
} {
  // Assign names to services based on their keys in the map
  const serviceMap = Object.fromEntries(
    Object.entries(config.services).map(([name, service]) => [
      name,
      { ...service, name, path: service.path || name },
    ]),
  ) as {
    readonly [K in keyof TServiceMap]: ExtractServiceWithName<TServiceMap[K], K & string>
  }

  // Invoke each per-service factory with the (runtime-identical) helpers
  const relationships: SchemaRelationships = {}
  for (const [name, factory] of Object.entries(config.relationships ?? {})) {
    if (factory) {
      relationships[name] = (factory as (h: unknown) => SchemaRelationships[string])({
        one,
        many,
        embed,
      })
    }
  }

  return {
    services: serviceMap,
    relationships: relationships as ResolvedRelationships<TServiceMap, TRelFactories>,
  }
}

// Type helpers to extract types from schema
export type ServiceNames<S extends Schema> = keyof S['services'] & string

export type ServiceByName<S extends Schema, N extends ServiceNames<S>> = S['services'][N]

export type ServiceItem<S extends Schema, N extends ServiceNames<S>> =
  ServiceByName<S, N> extends { [$phantom]?: { item: infer I } } ? I : Record<string, unknown>

export type ServiceCreate<S extends Schema, N extends ServiceNames<S>> =
  ServiceByName<S, N> extends { [$phantom]?: { create: infer C } } ? C : Record<string, unknown>

export type ServiceUpdate<S extends Schema, N extends ServiceNames<S>> =
  ServiceByName<S, N> extends { [$phantom]?: { update: infer U } } ? U : Record<string, unknown>

export type ServicePatch<S extends Schema, N extends ServiceNames<S>> =
  ServiceByName<S, N> extends { [$phantom]?: { patch: infer P } } ? P : Record<string, unknown>

export type ServiceQuery<S extends Schema, N extends ServiceNames<S>> =
  ServiceByName<S, N> extends { [$phantom]?: { query: infer Q } } ? Q : Record<string, unknown>

export type ServiceMethods<S extends Schema, N extends ServiceNames<S>> =
  ServiceByName<S, N> extends { [$phantom]?: { methods: infer M extends AnyMethodsType } }
    ? M
    : Record<string, never>

// Helper to find service by name string (for runtime lookup)
export function findServiceByName<S extends Schema>(
  schema: S | undefined,
  name: string,
): Service | undefined {
  if (!schema) return undefined
  return schema.services[name]
}

export function resolveServicePath<S extends Schema>(schema: S | undefined, name: string): string {
  return findServiceByName(schema, name)?.path ?? name
}

// Type guard to check if schema is defined
export function hasSchema<S extends Schema>(schema: S | undefined): schema is S {
  return schema !== undefined
}

// Default schema type when no schema is provided
// Use a branded subtype of Schema so we can detect "untyped schema" in conditional types
declare const $anySchemaBrand: unique symbol
export interface AnySchema extends Schema {
  readonly [$anySchemaBrand]: 'AnySchema'
}
