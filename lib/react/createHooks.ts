import { splitConfig, type Figbird } from '../core/figbird.js'
import type {
  Schema,
  ServiceItem,
  ServiceMethods,
  ServiceNames,
  ServiceQuery,
} from '../core/schema.js'
import { findServiceByName } from '../core/schema.js'
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
 * const adapter = new FeathersAdapter(feathers)
 * const figbird = new Figbird({ adapter, schema })
 * const { useFind, useGet, useMutation } = createHooks(figbird)
 *
 * // component.tsx
 * import { useFind } from './hooks'
 *
 * function MyComponent() {
 *   const people = useFind('api/people') // Fully typed to QueryResult<Person[], FeathersFindMeta>
 * }
 * ```
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createHooks<F extends Figbird<any, any>>(
  figbird: F,
): {
  useGet: UseGetForSchema<InferSchema<F>, InferMeta<F>>
  useFind: UseFindForSchema<InferSchema<F>, InferMeta<F>>
  useMutation: UseMutationForSchema<InferSchema<F>>
} {
  type S = InferSchema<F>
  type TMeta = InferMeta<F>

  // The internal implementations are weakly typed with `string` for serviceName.
  // The strong typing is enforced by the return type signature,
  // which correctly narrows the types based on the literal service name provided.

  function useTypedGet<N extends ServiceNames<S>>(
    serviceName: N,
    resourceId: string | number,
    params?: ServiceQuery<S, N>,
  ) {
    const service = findServiceByName(figbird.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    const { desc, config } = splitConfig(
      Object.assign({ serviceName: actualServiceName, method: 'get' as const, resourceId }, params),
    )
    return useQuery<ServiceItem<S, N>, TMeta>(desc, config)
  }

  function useTypedFind<N extends ServiceNames<S>>(serviceName: N, params?: ServiceQuery<S, N>) {
    const service = findServiceByName(figbird.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    const { desc, config } = splitConfig(
      Object.assign({ serviceName: actualServiceName, method: 'find' as const }, params),
    )
    return useQuery<ServiceItem<S, N>[], TMeta>(desc, config)
  }

  function useTypedMutation<N extends ServiceNames<S>>(serviceName: N) {
    const service = findServiceByName(figbird.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    return useBaseMutation<ServiceItem<S, N>, ServiceMethods<S, N>>(actualServiceName)
  }

  return {
    useGet: useTypedGet as UseGetForSchema<S, TMeta>,
    useFind: useTypedFind as UseFindForSchema<S, TMeta>,
    useMutation: useTypedMutation as UseMutationForSchema<S>,
  }
}
