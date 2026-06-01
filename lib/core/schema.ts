/**
 * Schema types for Figbird.
 *
 * A schema is backed by a plain service-definition map:
 * `{ serviceName: { item, create?, update?, patch?, query?, methods? } }`.
 * Runtime configuration is optional and only describes service metadata that
 * TypeScript cannot provide after type erasure, such as transport paths.
 */

declare const $schemaDefinitions: unique symbol

// Arbitrary service methods must preserve their own argument and return types.
// `any` is intentional here: `unknown[]` would reject concrete method signatures.
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export type ServiceMethod = (...args: any[]) => any
export type ServiceMethodsMap = Record<string, ServiceMethod>

export interface ServiceDefinition {
  item: unknown
  create?: unknown
  update?: unknown
  patch?: unknown
  query?: unknown
  methods?: ServiceMethodsMap
}

export type ServiceDefinitionMap<TServiceDefs> = {
  [K in keyof TServiceDefs]: ServiceDefinition
}

interface UntypedServiceDefinition extends ServiceDefinition {
  item: Record<string, unknown>
  create: Record<string, unknown>
  update: Record<string, unknown>
  patch: Record<string, unknown>
  query: Record<string, unknown>
  methods: Record<string, never>
}

export interface ServiceConfig {
  /**
   * Transport-level service name. When omitted, the schema key is used.
   *
   * This lets app code use ergonomic schema keys (`people`) while adapters still
   * call the real backend service path (`api/people`).
   */
  readonly path?: string
}

export type SchemaServiceConfig<TServiceName extends string = string> = Partial<
  Record<TServiceName, ServiceConfig>
>

export interface SchemaConfig<TServiceName extends string = string> {
  readonly services?: SchemaServiceConfig<TServiceName>
}

export interface Schema {
  readonly services?: SchemaServiceConfig
  readonly [$schemaDefinitions]?: unknown
}

export interface TypedSchema<
  TServiceDefs extends ServiceDefinitionMap<TServiceDefs>,
> extends Schema {
  readonly services?: SchemaServiceConfig<keyof TServiceDefs & string>
  readonly [$schemaDefinitions]?: TServiceDefs
}

type DeriveCreate<TServiceDef extends ServiceDefinition> = 'create' extends keyof TServiceDef
  ? Exclude<TServiceDef['create'], undefined>
  : Partial<TServiceDef['item']>

type DeriveUpdate<TServiceDef extends ServiceDefinition> = 'update' extends keyof TServiceDef
  ? Exclude<TServiceDef['update'], undefined>
  : TServiceDef['item']

type DerivePatch<TServiceDef extends ServiceDefinition> = 'patch' extends keyof TServiceDef
  ? Exclude<TServiceDef['patch'], undefined>
  : Partial<TServiceDef['item']>

type DeriveMethods<TServiceDef extends ServiceDefinition> = 'methods' extends keyof TServiceDef
  ? Exclude<TServiceDef['methods'], undefined> extends infer TMethods extends ServiceMethodsMap
    ? TMethods
    : Record<never, never>
  : Record<never, never>

type DeriveQuery<TServiceDef extends ServiceDefinition> = 'query' extends keyof TServiceDef
  ? Exclude<TServiceDef['query'], undefined>
  : Record<string, unknown>

export function defineSchema<const TServiceDefs extends ServiceDefinitionMap<TServiceDefs>>(
  config: SchemaConfig<keyof TServiceDefs & string> = {},
): TypedSchema<TServiceDefs> {
  return config as TypedSchema<TServiceDefs>
}

export type SchemaDefinitions<S extends Schema> =
  S extends TypedSchema<infer TServiceDefs> ? TServiceDefs : never

// Type helpers to extract types from schema
export type ServiceNames<S extends Schema> =
  S extends TypedSchema<infer TServiceDefs> ? keyof TServiceDefs & string : never

export type ServiceByName<S extends Schema, N extends ServiceNames<S>> = SchemaDefinitions<S>[N]

export type ServiceItem<S extends Schema, N extends ServiceNames<S>> = ServiceByName<S, N>['item']

export type ServiceCreate<S extends Schema, N extends ServiceNames<S>> = DeriveCreate<
  ServiceByName<S, N>
>

export type ServiceUpdate<S extends Schema, N extends ServiceNames<S>> = DeriveUpdate<
  ServiceByName<S, N>
>

export type ServicePatch<S extends Schema, N extends ServiceNames<S>> = DerivePatch<
  ServiceByName<S, N>
>

export type ServiceQuery<S extends Schema, N extends ServiceNames<S>> = DeriveQuery<
  ServiceByName<S, N>
>

export type ServiceMethods<S extends Schema, N extends ServiceNames<S>> = DeriveMethods<
  ServiceByName<S, N>
>

// Utility types to extract payloads from one service definition
export type Item<TServiceDef extends ServiceDefinition> = TServiceDef['item']

export type Create<TServiceDef extends ServiceDefinition> = DeriveCreate<TServiceDef>

export type Update<TServiceDef extends ServiceDefinition> = DeriveUpdate<TServiceDef>

export type Patch<TServiceDef extends ServiceDefinition> = DerivePatch<TServiceDef>

export type Query<TServiceDef extends ServiceDefinition> = DeriveQuery<TServiceDef>

export type Methods<TServiceDef extends ServiceDefinition> = DeriveMethods<TServiceDef>

export function resolveServicePath<S extends Schema>(schema: S | undefined, name: string): string {
  return schema?.services?.[name]?.path ?? name
}

// Type guard to check if schema is defined
export function hasSchema<S extends Schema>(schema: S | undefined): schema is S {
  return schema !== undefined
}

// Default schema type when no schema is provided
// Use a branded subtype of Schema so we can detect "untyped schema" in conditional types
declare const $anySchemaBrand: unique symbol
export interface AnySchema extends TypedSchema<Record<string, UntypedServiceDefinition>> {
  readonly [$anySchemaBrand]: 'AnySchema'
}

// Type for untyped services (fallback for services not in schema)
export type UntypedService = { readonly name: string }
