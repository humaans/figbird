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
> {
  constructor(
    public readonly name: string,
    public readonly _phantom?: {
      item: TItem
      query: TQuery
      methods: TMethods
    },
  ) {}

  methods<M extends Record<string, (...args: unknown[]) => unknown>>(): Service<TItem, TQuery, M> {
    return new Service(this.name) as Service<TItem, TQuery, M>
  }

  queryExtensions<Q extends Record<string, unknown>>(): Service<TItem, TQuery & Q, TMethods> {
    return new Service(this.name) as Service<TItem, TQuery & Q, TMethods>
  }
}

// Helper to create a service
export function service<
  TItem extends BaseItem,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
>(name: string): Service<TItem, TQuery> {
  return new Service<TItem, TQuery>(name)
}

// Schema definition
export interface Schema<
  TServices extends Record<
    string,
    Service<BaseItem, Record<string, unknown>, Record<string, never>>
  > = Record<string, Service<BaseItem, Record<string, unknown>, Record<string, never>>>,
> {
  services: TServices
  // Future: relationships
}

// Type helpers to extract types from schema
export type ServiceNames<S extends Schema> = keyof S['services'] & string

export type ServiceByName<S extends Schema, N extends ServiceNames<S>> = S['services'][N]

export type ServiceItem<S extends Schema, N extends ServiceNames<S>> =
  S['services'][N] extends Service<infer I, Record<string, unknown>, Record<string, never>>
    ? I
    : never

export type ServiceQuery<S extends Schema, N extends ServiceNames<S>> =
  S['services'][N] extends Service<BaseItem, infer Q, Record<string, never>> ? Q : never

export type ServiceMethods<S extends Schema, N extends ServiceNames<S>> =
  S['services'][N] extends Service<BaseItem, Record<string, unknown>, infer M> ? M : never

// Utility type to extract item type from a service
export type Item<S> =
  S extends Service<infer I, Record<string, unknown>, Record<string, never>> ? I : never

// Utility type to extract query type from a service
export type Query<S> = S extends Service<BaseItem, infer Q, Record<string, never>> ? Q : never

// Utility type to extract methods from a service
export type Methods<S> = S extends Service<BaseItem, Record<string, unknown>, infer M> ? M : never

// Helper to find service by name string (for runtime lookup)
export function findServiceByName<S extends Schema>(
  schema: S | undefined,
  name: string,
): Service<BaseItem, Record<string, unknown>, Record<string, never>> | undefined {
  if (!schema) return undefined

  // Direct lookup first
  if (name in schema.services) {
    return schema.services[name as keyof typeof schema.services]
  }

  // Then check by service.name property
  for (const service of Object.values(schema.services)) {
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
  Record<string, Service<BaseItem, Record<string, unknown>, Record<string, never>>>
>

// Type for untyped services (backward compatibility)
export type UntypedService = Service<BaseItem, Record<string, unknown>, Record<string, never>>
