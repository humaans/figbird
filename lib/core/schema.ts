/**
 * 1. Basic string-literal types we allow in "properties".
 */
export type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'json'

/**
 * 2. Map each ValueType to an actual *TypeScript* type.
 *    (These are erased at runtime, but TS uses them to infer.)
 */
type TypeMap = {
  string: string
  number: number
  boolean: boolean
  null: null
  json: any
}

/**
 * 3. A single service's definition:
 *    - `properties` is the user-supplied shape, e.g. { id: 'number', content: 'string' }
 *    - `resolvedType` is the *TypeScript*-level mapping from `properties`.
 */
export interface ServiceDefinition<TProps extends Record<string, ValueType>> {
  serviceName: string
  properties: TProps

  /**
   * The *inferred* TS type for each property.
   * e.g. if TProps = { id: 'number'; title: 'string' }
   * then `resolvedType` = { id: number; title: string }
   */
  resolvedType: { [K in keyof TProps]: TypeMap[TProps[K]] }
}

/**
 * 4. The function that creates a single service schema.
 *    - We fill in `resolvedType` purely for TS.
 */
export function createServiceSchema<TProps extends Record<string, ValueType>>(params: {
  serviceName: string
  properties: TProps
}): ServiceDefinition<TProps> {
  return {
    serviceName: params.serviceName,
    properties: params.properties,
    resolvedType: {} as ServiceDefinition<TProps>['resolvedType'], // purely for TS inference
  }
}

/**
 * 5. A "global" schema that references multiple services.
 *    (Adjust shape as needed. Some people put them directly in an object
 *     rather than nested under `.services`. Either way is fine.)
 */
export interface SchemaDefinition {
  services: Record<string, ServiceDefinition<any>>
}

/**
 * 6. The type of the final schema object.
 *    For each service key, we keep the entire ServiceDefinition
 *    so you still have .serviceName, .resolvedType, etc.
 */
export type Schema<T extends SchemaDefinition> = {
  [K in keyof T['services']]: T['services'][K]
}

/**
 * 7. Create the schema from a SchemaDefinition.
 *    This basically just returns `definition.services` in typed form.
 */
export function createSchema<T extends SchemaDefinition>(definition: T): Schema<T> {
  // Could do validation or transformations here if needed.
  return definition.services as Schema<T>
}

/**
 * 8. Utility type: Extract the actual "row type" from a schema + service key.
 *    e.g. If you have S = typeof schema and K='notes',
 *    this returns the shape: {id: number; content: string; ...}
 */
export type ServiceType<S extends Schema<any>, K extends keyof S> = S[K]['resolvedType']
export type InferServiceType<
  S extends Record<string, ServiceDefinition<any>>,
  K extends keyof S,
> = S[K]['resolvedType']
