import { splitConfig, type Figbird } from '../core/figbird.js'
import type {
  AnySchema,
  Schema,
  ServiceItem,
  ServiceMethods,
  ServiceNames,
  ServiceQuery,
} from '../core/schema.js'
import { findServiceByName } from '../core/schema.js'
import { useFigbird } from './react.js'
import { useMutation as useBaseMutation, type UseMutationResult } from './useMutation.js'
import { useQuery, type QueryResult } from './useQuery.js'

/**
 * Strongly-typed call signatures per service name.
 * Using a union of call signatures (one per service) gives the best inference:
 * passing a literal service name narrows the return type to that service.
 */
type UseGetForSchema<
  S extends Schema,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> = <N extends ServiceNames<S>>(
  serviceName: N,
  resourceId: string | number,
  params?: ServiceQuery<S, N>,
) => QueryResult<ServiceItem<S, N>, TMeta>

type UseFindForSchema<
  S extends Schema,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> = <N extends ServiceNames<S>>(
  serviceName: N,
  params?: ServiceQuery<S, N>,
) => QueryResult<ServiceItem<S, N>[], TMeta>

type UseMutationForSchema<S extends Schema> = <N extends ServiceNames<S>>(
  serviceName: N,
) => UseMutationResult<ServiceItem<S, N>, ServiceMethods<S, N>>

// Type helper to extract schema and meta types from a Figbird instance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InferSchema<F> = F extends Figbird<infer S, any> ? S : never
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InferMeta<F> = F extends Figbird<any, infer M> ? M : never

/**
 * Creates typed hooks for a specific schema.
 *
 * Usage:
 * ```typescript
 * // Option 1: Pass figbird instance (recommended - infers both schema and meta)
 * const adapter = new FeathersAdapter(feathers)
 * const figbird = new Figbird({ adapter, schema })
 * const { useFind, useGet, useMutation } = createHooks(figbird)
 *
 * // Option 2: Pass types explicitly (backward compatible)
 * const { useFind, useGet, useMutation } = createHooks<AppSchema, FeathersFindMeta>()
 *
 * // component.tsx
 * import { useFind } from './hooks'
 *
 * function MyComponent() {
 *   const people = useFind('api/people') // Fully typed to QueryResult<Person[], FeathersFindMeta>
 * }
 * ```
 */

// Overload 1: Accept a Figbird instance and infer types from it
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createHooks<F extends Figbird<any, any>>(
  figbird: F,
): {
  useGet: UseGetForSchema<InferSchema<F>, InferMeta<F>>
  useFind: UseFindForSchema<InferSchema<F>, InferMeta<F>>
  useMutation: UseMutationForSchema<InferSchema<F>>
}

// Overload 2: Accept explicit type parameters (backward compatible)
// eslint-disable-next-line no-redeclare
export function createHooks<
  S extends Schema = AnySchema,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
>(): {
  useGet: UseGetForSchema<S, TMeta>
  useFind: UseFindForSchema<S, TMeta>
  useMutation: UseMutationForSchema<S>
}

// Implementation
// eslint-disable-next-line no-redeclare
export function createHooks<
  S extends Schema = AnySchema,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
>(
  figbird?: Figbird<S, TMeta>,
): {
  useGet: UseGetForSchema<S, TMeta>
  useFind: UseFindForSchema<S, TMeta>
  useMutation: UseMutationForSchema<S>
} {
  // The internal implementations are weakly typed with `string` for serviceName.
  // The strong typing is enforced by the `TypedHooks<S>` return type signature,
  // which correctly narrows the types based on the literal service name provided.

  function useTypedGet<N extends ServiceNames<S>>(
    serviceName: N,
    resourceId: string | number,
    params?: ServiceQuery<S, N>,
  ) {
    const figbirdInstance = figbird ?? useFigbird<S, TMeta>()
    const service = findServiceByName(figbirdInstance.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    const { desc, config } = splitConfig(
      Object.assign({ serviceName: actualServiceName, method: 'get' as const, resourceId }, params),
    )
    return useQuery<ServiceItem<S, N>, TMeta>(desc, config)
  }

  function useTypedFind<N extends ServiceNames<S>>(serviceName: N, params?: ServiceQuery<S, N>) {
    const figbirdInstance = figbird ?? useFigbird<S, TMeta>()
    const service = findServiceByName(figbirdInstance.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    const { desc, config } = splitConfig(
      Object.assign({ serviceName: actualServiceName, method: 'find' as const }, params),
    )
    return useQuery<ServiceItem<S, N>[], TMeta>(desc, config)
  }

  function useTypedMutation<N extends ServiceNames<S>>(serviceName: N) {
    const figbirdInstance = figbird ?? useFigbird<S, TMeta>()
    const service = findServiceByName(figbirdInstance.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    return useBaseMutation<ServiceItem<S, N>, ServiceMethods<S, N>>(actualServiceName)
  }

  return {
    useGet: useTypedGet as UseGetForSchema<S, TMeta>,
    useFind: useTypedFind as UseFindForSchema<S, TMeta>,
    useMutation: useTypedMutation as UseMutationForSchema<S>,
  }
}
