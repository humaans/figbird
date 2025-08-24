/**
 * Schema types for Figbird
 * These types enable type-safe service definitions and query inference
 */

// Base service item type - all items should have an id
export interface BaseItem {
  id?: string | number
  _id?: string | number
  [key: string]: unknown
}

// Service definition with custom methods
export class Service<
  TItem extends BaseItem = BaseItem,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
  TMethods extends Record<string, (...args: unknown[]) => unknown> = Record<string, never>,
  TName extends string = string,
> {
  public readonly name: TName
  public readonly _phantom?: {
    item: TItem
    query: TQuery
    methods: TMethods
  }

  constructor(name: TName) {
    this.name = name
  }

  methods<M extends Record<string, (...args: unknown[]) => unknown>>(): Service<
    TItem,
    TQuery,
    M,
    TName
  > {
    return new Service(this.name) as Service<TItem, TQuery, M, TName>
  }

  queryExtensions<Q extends Record<string, unknown>>(): Service<
    TItem,
    TQuery & Q,
    TMethods,
    TName
  > {
    return new Service(this.name) as Service<TItem, TQuery & Q, TMethods, TName>
  }
}

// Helper to create a service
export function service<
  TItem extends BaseItem,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
  TName extends string = string,
>(name: TName): Service<TItem, TQuery, Record<string, never>, TName> {
  return new Service<TItem, TQuery, Record<string, never>, TName>(name)
}

// Schema definition - using a mapped type for better inference
export interface Schema {
  services: Record<string, Service<any, any, any, string>>
}

// Helper to create a schema from an array of services
export function createSchema<
  TServices extends ReadonlyArray<Service<any, any, any, string>>,
>(config: {
  services: TServices
}): {
  services: {
    [K in TServices[number] as K['name']]: K
  }
} {
  const serviceMap = {} as any
  for (const service of config.services) {
    serviceMap[service.name] = service
  }
  return { services: serviceMap }
}

// Type helpers to extract types from schema
export type ServiceNames<S extends Schema> = keyof S['services'] & string

export type ServiceByName<S extends Schema, N extends ServiceNames<S>> = S['services'][N]

export type ServiceItem<S extends Schema, N extends ServiceNames<S>> =
  S['services'][N] extends Service<infer I, any, any, any> ? I : never

export type ServiceQuery<S extends Schema, N extends ServiceNames<S>> =
  S['services'][N] extends Service<any, infer Q, any, any> ? Q : never

export type ServiceMethods<S extends Schema, N extends ServiceNames<S>> =
  S['services'][N] extends Service<any, any, infer M, any> ? M : never

// Utility type to extract item type from a service
export type Item<S> = S extends Service<infer I, any, any, any> ? I : never

// Utility type to extract query type from a service
export type Query<S> = S extends Service<any, infer Q, any, any> ? Q : never

// Utility type to extract methods from a service
export type Methods<S> = S extends Service<any, any, infer M, any> ? M : never

// Helper to find service by name string (for runtime lookup)
export function findServiceByName<S extends Schema>(
  schema: S | undefined,
  name: string,
): Service<any, any, any, string> | undefined {
  if (!schema) return undefined
  return schema.services[name]
}

// Type guard to check if schema is defined
export function hasSchema<S extends Schema>(schema: S | undefined): schema is S {
  return schema !== undefined
}

// Default schema type when no schema is provided
export type AnySchema = Schema

// Type for untyped services (backward compatibility)
export type UntypedService = Service<
  BaseItem,
  Record<string, unknown>,
  Record<string, never>,
  string
>
