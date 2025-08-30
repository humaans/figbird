/**
 * Schema types for Figbird
 * These types enable type-safe service definitions and query inference
 */

// Unique symbol for phantom types - keeps internal typing machinery hidden
declare const $phantom: unique symbol

// Service definition with custom methods - simplified for better type inference
export interface Service<
  TItem = Record<string, unknown>,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
  TName extends string = string,
> {
  readonly name: TName
  readonly [$phantom]?: {
    item: TItem
    query: TQuery
  }
}

// Helper to create a service with proper literal type preservation
export function service<
  TItem,
  TName extends string,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
>(name: TName): Service<TItem, TQuery, TName> {
  return {
    name,
  } as Service<TItem, TQuery, TName>
}

// Schema definition - using a mapped type for better inference
export interface Schema {
  services: Record<string, Service<unknown, Record<string, unknown>, string>>
}

// Helper to create a schema from an array of services using Extract-based narrowing
export function createSchema<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const TServices extends ReadonlyArray<Service<any, any, any>>,
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
  ServiceByName<S, N> extends Service<infer TItem, Record<string, unknown>, string>
    ? TItem
    : Record<string, unknown>

export type ServiceQuery<S extends Schema, N extends ServiceNames<S>> =
  ServiceByName<S, N> extends { [$phantom]?: { query: infer Q } } ? Q : Record<string, unknown>

// Utility type to extract item type from a service
export type Item<S> = S extends { [$phantom]?: { item: infer I } } ? I : Record<string, unknown>

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
export type AnySchema = Schema

// Type for untyped services (backward compatibility)
export type UntypedService = Service<Record<string, unknown>, Record<string, unknown>, string>
