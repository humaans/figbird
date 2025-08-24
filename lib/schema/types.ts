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
  constructor(
    public readonly name: TName,
    public readonly _phantom?: {
      item: TItem
      query: TQuery
      methods: TMethods
      name: TName
    },
  ) {}

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

// Schema definition
export interface Schema<
  TServices extends ReadonlyArray<
    Service<BaseItem, Record<string, unknown>, Record<string, never>, string>
  > = ReadonlyArray<Service<BaseItem, Record<string, unknown>, Record<string, never>, string>>,
> {
  services: TServices
  // Future: relationships
}

// Type helpers to extract types from schema
export type ServiceNames<S extends Schema> =
  S['services'][number] extends Service<
    BaseItem,
    Record<string, unknown>,
    Record<string, never>,
    infer N
  >
    ? N
    : never

export type ServiceByName<S extends Schema, N extends string> = Extract<
  S['services'][number],
  Service<BaseItem, Record<string, unknown>, Record<string, never>, N>
>

export type ServiceItem<S extends Schema, N extends string> =
  ServiceByName<S, N> extends Service<infer I, Record<string, unknown>, Record<string, never>, N>
    ? I
    : never

export type ServiceQuery<S extends Schema, N extends string> =
  ServiceByName<S, N> extends Service<BaseItem, infer Q, Record<string, never>, N> ? Q : never

export type ServiceMethods<S extends Schema, N extends string> =
  ServiceByName<S, N> extends Service<BaseItem, Record<string, unknown>, infer M, N> ? M : never

// Utility type to extract item type from a service
export type Item<S> =
  S extends Service<infer I, Record<string, unknown>, Record<string, never>, string> ? I : never

// Utility type to extract query type from a service
export type Query<S> =
  S extends Service<BaseItem, infer Q, Record<string, never>, string> ? Q : never

// Utility type to extract methods from a service
export type Methods<S> =
  S extends Service<BaseItem, Record<string, unknown>, infer M, string> ? M : never

// Helper to find service by name string (for runtime lookup)
export function findServiceByName<S extends Schema>(
  schema: S | undefined,
  name: string,
): Service<BaseItem, Record<string, unknown>, Record<string, never>, string> | undefined {
  if (!schema) return undefined

  // Search through array of services by name
  for (const service of schema.services) {
    if (service.name === name) {
      return service
    }
  }

  return undefined
}

// Type guard to check if schema is defined
export function hasSchema<S extends Schema>(schema: S | undefined): schema is S {
  return schema !== undefined
}

// Default schema type when no schema is provided
export type AnySchema = Schema<
  ReadonlyArray<Service<BaseItem, Record<string, unknown>, Record<string, never>, string>>
>

// Type for untyped services (backward compatibility)
export type UntypedService = Service<
  BaseItem,
  Record<string, unknown>,
  Record<string, never>,
  string
>
