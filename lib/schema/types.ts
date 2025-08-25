/**
 * Schema types for Figbird
 * These types enable type-safe service definitions and query inference
 */

// Service definition with custom methods - simplified for better type inference
export interface Service<
  TItem = Record<string, unknown>,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
  TMethods extends Record<string, (...args: unknown[]) => unknown> = Record<string, never>,
  TName extends string = string,
> {
  readonly name: TName
  readonly _phantom?: {
    item: TItem
    query: TQuery
    methods: TMethods
  }
}

// Helper to create a service with proper literal type preservation
export function service<
  TItem,
  TName extends string,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
>(name: TName): Service<TItem, TQuery, Record<string, never>, TName> {
  return {
    name,
  } as Service<TItem, TQuery, Record<string, never>, TName>
}

// Schema definition - using a mapped type for better inference
export interface Schema {
  services: Record<
    string,
    Service<
      unknown,
      Record<string, unknown>,
      Record<string, (...args: unknown[]) => unknown>,
      string
    >
  >
}

// Helper to create a schema from an array of services using Extract-based narrowing
export function createSchema<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const TServices extends ReadonlyArray<Service<any, any, any, any>>,
>(config: {
  services: TServices
}): {
  services: {
    readonly [K in TServices[number]['name']]: Extract<TServices[number], { name: K }>
  }
} {
  const serviceMap = Object.fromEntries(
    config.services.map(service => [service.name, service]),
  ) as { [K in TServices[number]['name']]: Extract<TServices[number], { name: K }> }
  return { services: serviceMap }
}

// Type helpers to extract types from schema
export type ServiceNames<S extends Schema> = keyof S['services'] & string

export type ServiceByName<S extends Schema, N extends ServiceNames<S>> = S['services'][N]

export type ServiceItem<S extends Schema, N extends ServiceNames<S>> =
  ServiceByName<S, N> extends Service<
    infer TItem,
    Record<string, unknown>,
    Record<string, (...args: unknown[]) => unknown>,
    string
  >
    ? TItem
    : Record<string, unknown>

export type ServiceQuery<S extends Schema, N extends ServiceNames<S>> = ServiceByName<
  S,
  N
>['_phantom'] extends {
  query: infer Q
}
  ? Q
  : Record<string, unknown>

export type ServiceMethods<S extends Schema, N extends ServiceNames<S>> = ServiceByName<
  S,
  N
>['_phantom'] extends {
  methods: infer M
}
  ? M
  : Record<string, never>

// Utility type to extract item type from a service
export type Item<S> = S extends { _phantom?: { item: infer I } } ? I : Record<string, unknown>

// Utility type to extract query type from a service
export type Query<S> = S extends { _phantom?: { query: infer Q } } ? Q : Record<string, unknown>

// Utility type to extract methods from a service
export type Methods<S> = S extends { _phantom?: { methods: infer M } } ? M : Record<string, never>

// Helper to find service by name string (for runtime lookup)
export function findServiceByName<S extends Schema>(
  schema: S | undefined,
  name: string,
):
  | Service<
      unknown,
      Record<string, unknown>,
      Record<string, (...args: unknown[]) => unknown>,
      string
    >
  | undefined {
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
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, never>,
  string
>
