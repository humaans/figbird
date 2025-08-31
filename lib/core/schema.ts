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
  query?: Record<string, unknown>
}

// Internal service representation - matches expected type structure
export interface Service<
  TItem = Record<string, unknown>,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
  TName extends string = string,
> {
  readonly name: TName
  readonly [$phantom]?: {
    item: TItem
    query: TQuery
    // Store additional payload types from service definition
    create: unknown
    update: unknown
    patch: unknown
  }
}

// Phase 1: Create a service definition (no name yet)
export function service<TServiceDef extends ServiceTypeDefinition>(): Service<
  TServiceDef['item'],
  TServiceDef extends { query: infer Q } ? Q : Record<string, unknown>,
  string
> & {
  readonly [$phantom]?: {
    item: TServiceDef['item']
    query: TServiceDef extends { query: infer Q } ? Q : Record<string, unknown>
    create: TServiceDef['create'] extends undefined
      ? Partial<TServiceDef['item']>
      : TServiceDef['create']
    update: TServiceDef['update'] extends undefined ? TServiceDef['item'] : TServiceDef['update']
    patch: TServiceDef['patch'] extends undefined
      ? Partial<TServiceDef['item']>
      : TServiceDef['patch']
  }
} {
  return {
    name: '', // Name will be set in createSchema
  } as Service<
    TServiceDef['item'],
    TServiceDef extends { query: infer Q } ? Q : Record<string, unknown>,
    string
  > & {
    readonly [$phantom]?: {
      item: TServiceDef['item']
      query: TServiceDef extends { query: infer Q } ? Q : Record<string, unknown>
      create: TServiceDef['create'] extends undefined
        ? Partial<TServiceDef['item']>
        : TServiceDef['create']
      update: TServiceDef['update'] extends undefined ? TServiceDef['item'] : TServiceDef['update']
      patch: TServiceDef['patch'] extends undefined
        ? Partial<TServiceDef['item']>
        : TServiceDef['patch']
    }
  }
}

// Base schema interface - flexible to preserve specific service types
export interface Schema {
  services: Record<string, Service<unknown, Record<string, unknown>, string>>
}

// Phase 2: Create a schema with services object map (preserves literal keys)
export function createSchema<
  const TServiceMap extends Record<string, Service<unknown, Record<string, unknown>, string>>,
>(config: {
  services: TServiceMap
}): {
  services: {
    readonly [K in keyof TServiceMap]: TServiceMap[K] extends Service<
      infer TItem,
      infer TQuery,
      string
    >
      ? Service<TItem, TQuery, K & string>
      : never
  }
} {
  // Assign names to services based on their keys in the map
  const serviceMap = Object.fromEntries(
    Object.entries(config.services).map(([name, service]) => [name, { ...service, name }]),
  ) as {
    readonly [K in keyof TServiceMap]: TServiceMap[K] extends Service<
      infer TItem,
      infer TQuery,
      string
    >
      ? Service<TItem, TQuery, K & string>
      : never
  }
  return { services: serviceMap }
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

// Helper to find service by name string (for runtime lookup)
export function findServiceByName<S extends Schema>(
  schema: S | undefined,
  name: string,
): Service<unknown, Record<string, unknown>, string> | undefined {
  if (!schema) return undefined
  return schema.services[name]
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
export type UntypedService = Service<Record<string, unknown>, Record<string, unknown>, string>
