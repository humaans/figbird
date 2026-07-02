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

// Internal service representation - matches expected type structure
export interface Service<
  TItem = Record<string, unknown>,
  TQuery = Record<string, unknown>,
  TName extends string = string,
  TCreate = unknown,
  TUpdate = unknown,
  TPatch = unknown,
  TMethods extends AnyMethodsType = AnyMethodsType,
> {
  readonly name: TName
  readonly path: string
  readonly [$phantom]?: {
    item: TItem
    query: TQuery
    create: TCreate
    update: TUpdate
    patch: TPatch
    methods: TMethods
  }
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

// Phase 1: Create a service definition (no name yet)
export function service<
  TServiceDef extends ServiceTypeDefinition,
  const TPath extends string = string,
>(
  options: ServiceOptions<TPath> = {},
): Service<
  TServiceDef['item'],
  DeriveQuery<TServiceDef>,
  string,
  DeriveCreate<TServiceDef>,
  DeriveUpdate<TServiceDef>,
  DerivePatch<TServiceDef>,
  DeriveMethods<TServiceDef>
> {
  return { name: '', path: options.path ?? '' } as Service<
    TServiceDef['item'],
    DeriveQuery<TServiceDef>,
    string,
    DeriveCreate<TServiceDef>,
    DeriveUpdate<TServiceDef>,
    DerivePatch<TServiceDef>,
    DeriveMethods<TServiceDef>
  >
}

// Base schema interface - flexible to preserve specific service types
export interface Schema {
  services: Record<string, Service<unknown, unknown, string>>
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
 * - `'one'`      — single related item resolved by `parent.sourceField → dest.destField`
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
   * First hop for two-hop `many` relations (junction-table many-to-many). When present,
   * `sourceField` / `destService` / `destField` describe the second hop (junction → dest)
   * and `via` describes the first (parent → junction). Capped at two hops total.
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
 * Hop config — one segment of a relationship's traversal. For single-hop relations there's
 * just one of these; for two-hop `many` (junction tables) there are two.
 */
export interface RelationshipHop<TDest extends string = string> {
  sourceField: string[]
  destService: TDest
  destField: string[]
  query?: Record<string, unknown>
}

/**
 * Helper to define a one-to-one relationship.
 *
 * The bare form (no schema binding) is useful outside the factory. Inside createSchema's
 * relationships factory, prefer the `one` helper from the factory argument — it's typed
 * so destService is constrained to one of your schema's service names.
 */
export function one<TDest extends string>(
  def: RelationshipHop<TDest>,
): RelationshipDef<TDest, 'one'> {
  return { ...def, cardinality: 'one' }
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
 * See `one` for typing notes.
 */
export function many<TDest extends string>(
  def: RelationshipHop<TDest>,
): RelationshipDef<TDest, 'many'>
export function many<TJunction extends string, TDest extends string>(
  parentToJunction: RelationshipHop<TJunction>,
  junctionToDest: RelationshipHop<TDest>,
): RelationshipDef<TDest, 'many'>
export function many(
  first: RelationshipHop<string>,
  second?: RelationshipHop<string>,
): RelationshipDef<string, 'many'> {
  if (!second) {
    return { ...first, cardinality: 'many' }
  }
  return {
    sourceField: second.sourceField,
    destService: second.destService,
    destField: second.destField,
    cardinality: 'many',
    ...(second.query ? { query: second.query } : {}),
    via: {
      sourceField: first.sourceField,
      destService: first.destService,
      destField: first.destField,
      ...(first.query ? { query: first.query } : {}),
    },
  }
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
export function embed<TDest extends string>(
  def: RelationshipHop<TDest>,
): RelationshipDef<TDest, 'embedded'> {
  return { ...def, cardinality: 'embedded' }
}

/**
 * Relationship helpers passed to the relationships factory. The factory variant is
 * generic over the service map so `destService` is constrained to `keyof TServices`.
 * Concretely: inside `createSchema({ services, relationships: ({ one }) => ({...}) })`,
 * autocompletion for `destService` only offers services that actually exist.
 */
export interface RelationshipHelpers<
  TServices = Record<string, Service<unknown, unknown, string>>,
> {
  one: <TDest extends keyof TServices & string>(
    def: RelationshipHop<TDest>,
  ) => RelationshipDef<TDest, 'one'>
  many: {
    <TDest extends keyof TServices & string>(
      def: RelationshipHop<TDest>,
    ): RelationshipDef<TDest, 'many'>
    <TJunction extends keyof TServices & string, TDest extends keyof TServices & string>(
      parentToJunction: RelationshipHop<TJunction>,
      junctionToDest: RelationshipHop<TDest>,
    ): RelationshipDef<TDest, 'many'>
  }
  embed: <TDest extends keyof TServices & string>(
    def: RelationshipHop<TDest>,
  ) => RelationshipDef<TDest, 'embedded'>
}

/**
 * Factory function type for defining relationships.
 */
export type RelationshipsFactory<TServiceMap> = (
  helpers: RelationshipHelpers<TServiceMap>,
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
) => { [K in keyof TServiceMap]?: Record<string, RelationshipDef<any, any>> }

// Helper type to extract all service parameters and update name
type ExtractServiceWithName<S, N extends string> =
  S extends Service<
    infer TItem,
    infer TQuery,
    string,
    infer TCreate,
    infer TUpdate,
    infer TPatch,
    infer TMethods extends AnyMethodsType
  >
    ? Service<TItem, TQuery, N, TCreate, TUpdate, TPatch, TMethods>
    : never

// Phase 2: Create a schema with services object map (preserves literal keys + typed
// relationships so downstream hooks can infer related item types at call sites).
export function createSchema<
  const TServiceMap extends Record<string, Service<unknown, unknown, string>>,
  const TRelationships extends {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    [K in keyof TServiceMap]?: Record<string, RelationshipDef<any, any>>
  } = {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    [K in keyof TServiceMap]?: Record<string, RelationshipDef<any, any>>
  },
>(config: {
  services: TServiceMap
  relationships?: (helpers: RelationshipHelpers<TServiceMap>) => TRelationships
}): {
  services: {
    readonly [K in keyof TServiceMap]: ExtractServiceWithName<TServiceMap[K], K & string>
  }
  relationships: TRelationships
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

  // Build relationships from factory function if provided
  const relationships = (
    config.relationships ? config.relationships({ one, many, embed }) : {}
  ) as TRelationships

  return { services: serviceMap, relationships }
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

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMethods = Record<string, (...args: any[]) => any>

export type ServiceMethods<S extends Schema, N extends ServiceNames<S>> =
  ServiceByName<S, N> extends { [$phantom]?: { methods: infer M extends AnyMethods } }
    ? M
    : Record<string, never>

// Utility type to extract item type from a service
export type Item<S> = S extends { [$phantom]?: { item: infer I } } ? I : Record<string, unknown>

// Utility type to extract create type from a service
export type Create<S> = S extends { [$phantom]?: { create: infer C } } ? C : Record<string, unknown>

// Utility type to extract update type from a service
export type Update<S> = S extends { [$phantom]?: { update: infer U } } ? U : Record<string, unknown>

// Utility type to extract patch type from a service
export type Patch<S> = S extends { [$phantom]?: { patch: infer P } } ? P : Record<string, unknown>

// Utility type to extract query type from a service
export type Query<S> = S extends { [$phantom]?: { query: infer Q } } ? Q : Record<string, unknown>

// Utility type to extract methods from a service
export type Methods<S> = S extends { [$phantom]?: { methods: infer M } } ? M : Record<string, never>

// Helper to find service by name string (for runtime lookup)
export function findServiceByName<S extends Schema>(
  schema: S | undefined,
  name: string,
): Service<unknown, unknown, string> | undefined {
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

// Type for untyped services (fallback for services not in schema)
export type UntypedService = Service<Record<string, unknown>, unknown, string>
