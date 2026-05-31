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
  readonly [$phantom]?: {
    item: TItem
    query: TQuery
    create: TCreate
    update: TUpdate
    patch: TPatch
    methods: TMethods
  }
}

// Helper types to derive payload types from service definition
type DeriveCreate<TServiceDef extends ServiceTypeDefinition> = 'create' extends keyof TServiceDef
  ? Exclude<TServiceDef['create'], undefined>
  : Partial<TServiceDef['item']>

type DeriveUpdate<TServiceDef extends ServiceTypeDefinition> = 'update' extends keyof TServiceDef
  ? Exclude<TServiceDef['update'], undefined>
  : TServiceDef['item']

type DerivePatch<TServiceDef extends ServiceTypeDefinition> = 'patch' extends keyof TServiceDef
  ? Exclude<TServiceDef['patch'], undefined>
  : Partial<TServiceDef['item']>

type DeriveMethods<TServiceDef extends ServiceTypeDefinition> = 'methods' extends keyof TServiceDef
  ? Exclude<TServiceDef['methods'], undefined> & AnyMethodsType
  : Record<string, never>

type DeriveQuery<TServiceDef extends ServiceTypeDefinition> = 'query' extends keyof TServiceDef
  ? Exclude<TServiceDef['query'], undefined>
  : Record<string, unknown>

type ServiceDefinitions<TServiceDefs> = {
  [K in keyof TServiceDefs]: ServiceTypeDefinition
}

type ServiceFromDefinition<
  TServiceDef extends ServiceTypeDefinition,
  TName extends string = string,
> = Service<
  TServiceDef['item'],
  DeriveQuery<TServiceDef>,
  TName,
  DeriveCreate<TServiceDef>,
  DeriveUpdate<TServiceDef>,
  DerivePatch<TServiceDef>,
  DeriveMethods<TServiceDef>
>

type ServiceMapFromDefinitions<
  TServiceDefs extends ServiceDefinitions<TServiceDefs>,
  TServiceName extends keyof TServiceDefs & string,
> = {
  readonly [K in TServiceName]: ServiceFromDefinition<TServiceDefs[K], K>
}

type DefineSchemaFor<TServiceDefs extends ServiceDefinitions<TServiceDefs>> = <
  const TServiceNames extends readonly (keyof TServiceDefs & string)[],
>(config: {
  services: TServiceNames
}) => {
  services: ServiceMapFromDefinitions<TServiceDefs, TServiceNames[number]>
}

// Phase 1: Create a service definition (no name yet)
export function defineService<
  TServiceDef extends ServiceTypeDefinition,
>(): ServiceFromDefinition<TServiceDef> {
  return { name: '' } as ServiceFromDefinition<TServiceDef>
}

// Base schema interface - flexible to preserve specific service types
export interface Schema {
  services: Record<string, Service<unknown, unknown, string>>
}

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

// Phase 2: Create a schema with services object map (preserves literal keys)
export function defineSchema<
  const TServiceMap extends Record<string, Service<unknown, unknown, string>>,
>(config: {
  services: TServiceMap
}): {
  services: {
    readonly [K in keyof TServiceMap]: ExtractServiceWithName<TServiceMap[K], K & string>
  }
} {
  // Assign names to services based on their keys in the map
  const serviceMap = Object.fromEntries(
    Object.entries(config.services).map(([name, service]) => [name, { ...service, name }]),
  ) as {
    readonly [K in keyof TServiceMap]: ExtractServiceWithName<TServiceMap[K], K & string>
  }
  return { services: serviceMap }
}

// Create a schema directly from a generated service contract map
export function defineSchemaFor<
  const TServiceDefs extends ServiceDefinitions<TServiceDefs>,
>(): DefineSchemaFor<TServiceDefs> {
  return (<const TServiceNames extends readonly (keyof TServiceDefs & string)[]>(config: {
    services: TServiceNames
  }) => {
    const services = Object.fromEntries(
      config.services.map(name => [
        name,
        { name } as ServiceFromDefinition<TServiceDefs[typeof name], typeof name>,
      ]),
    ) as unknown as ServiceMapFromDefinitions<TServiceDefs, TServiceNames[number]>

    return defineSchema({ services }) as {
      services: ServiceMapFromDefinitions<TServiceDefs, TServiceNames[number]>
    }
  }) as DefineSchemaFor<TServiceDefs>
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
