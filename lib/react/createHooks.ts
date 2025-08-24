import { splitConfig } from '../core/figbird.js'
import type {
  AnySchema,
  Schema,
  ServiceItem,
  ServiceMethods,
  ServiceNames,
  ServiceQuery,
} from '../schema/types.js'
import { findServiceByName } from '../schema/types.js'
import { useFigbird } from './react.js'
import { useMutation as useBaseMutation, type UseMutationResult } from './useMutation.js'
import { useQuery, type QueryResult } from './useQuery.js'

/**
 * Strongly-typed call signatures per service name.
 * Using a union of call signatures (one per service) gives the best inference:
 * passing a literal service name narrows the return type to that service.
 */
type UseGetForSchema<S extends Schema> = {
  [N in ServiceNames<S>]: (
    serviceName: N,
    resourceId: string | number,
    params?: ServiceQuery<S, N>,
  ) => QueryResult<ServiceItem<S, N>>
}[ServiceNames<S>]

type UseFindForSchema<S extends Schema> = {
  [N in ServiceNames<S>]: (
    serviceName: N,
    params?: ServiceQuery<S, N>,
  ) => QueryResult<ServiceItem<S, N>[]>
}[ServiceNames<S>]

type UseMutationForSchema<S extends Schema> = {
  [N in ServiceNames<S>]: (
    serviceName: N,
  ) => UseMutationResult<ServiceItem<S, N>, ServiceMethods<S, N>>
}[ServiceNames<S>]

/**
 * Creates typed hooks for a specific schema.
 *
 * Usage:
 * ```typescript
 * // hooks.ts
 * import { createHooks } from 'figbird'
 * import type { AppSchema } from './schema'
 *
 * export const { useFind, useGet, useMutation } = createHooks<AppSchema>()
 *
 * // component.tsx
 * import { useFind } from './hooks'
 *
 * function MyComponent() {
 *   const people = useFind('api/people') // Fully typed to QueryResult<Person[]>
 * }
 * ```
 */
export function createHooks<S extends Schema = AnySchema>(): {
  useGet: UseGetForSchema<S>
  useFind: UseFindForSchema<S>
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
    const figbird = useFigbird<S>()
    const service = findServiceByName(figbird.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    const { desc, config } = splitConfig(
      Object.assign({ serviceName: actualServiceName, method: 'get', resourceId }, params),
    )
    return useQuery<ServiceItem<S, N>>(desc, config)
  }

  function useTypedFind<N extends ServiceNames<S>>(serviceName: N, params?: ServiceQuery<S, N>) {
    const figbird = useFigbird<S>()
    const service = findServiceByName(figbird.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    const { desc, config } = splitConfig(
      Object.assign({ serviceName: actualServiceName, method: 'find' }, params),
    )
    return useQuery<ServiceItem<S, N>[]>(desc, config)
  }

  function useTypedMutation<N extends ServiceNames<S>>(serviceName: N) {
    const figbird = useFigbird<S>()
    const service = findServiceByName(figbird.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    return useBaseMutation<ServiceItem<S, N>, ServiceMethods<S, N>>(actualServiceName)
  }

  return {
    useGet: useTypedGet as UseGetForSchema<S>,
    useFind: useTypedFind as UseFindForSchema<S>,
    useMutation: useTypedMutation as UseMutationForSchema<S>,
  }
}
