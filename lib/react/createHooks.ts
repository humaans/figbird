import { splitConfig } from '../core/figbird.js'
import type {
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
 *   const people = useFind('api/people') // Fully typed!
 * }
 * ```
 */
export function createHooks<S extends Schema>() {
  function useTypedGet<N extends ServiceNames<S>>(
    serviceName: N,
    resourceId: string | number,
    params?: ServiceQuery<S, N>,
  ): QueryResult<ServiceItem<S, N>> {
    const figbird = useFigbird<S>()
    const service = findServiceByName(figbird.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    const { desc, config } = splitConfig({
      serviceName: actualServiceName,
      method: 'get',
      resourceId,
      ...params,
    })
    return useQuery<ServiceItem<S, N>>(desc, config)
  }

  function useTypedFind<N extends ServiceNames<S>>(
    serviceName: N,
    params?: ServiceQuery<S, N>,
  ): QueryResult<ServiceItem<S, N>[]> {
    const figbird = useFigbird<S>()
    const service = findServiceByName(figbird.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    const { desc, config } = splitConfig({
      serviceName: actualServiceName,
      method: 'find',
      ...params,
    })
    return useQuery<ServiceItem<S, N>[]>(desc, config)
  }

  function useTypedMutation<N extends ServiceNames<S>>(
    serviceName: N,
  ): UseMutationResult<ServiceItem<S, N>, ServiceMethods<S, N>> {
    const figbird = useFigbird<S>()
    const service = findServiceByName(figbird.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    return useBaseMutation<ServiceItem<S, N>>(actualServiceName) as unknown as UseMutationResult<
      ServiceItem<S, N>,
      ServiceMethods<S, N>
    >
  }

  return {
    useGet: useTypedGet,
    useFind: useTypedFind,
    useMutation: useTypedMutation,
  }
}
