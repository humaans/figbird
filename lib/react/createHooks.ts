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
 * This interface defines the shape of the returned hooks object.
 * Using overloaded function signatures with generics on the properties
 * themselves allows TypeScript to correctly infer the specific service type
 * from the literal string passed as `serviceName`.
 */
interface TypedHooks<S extends Schema> {
  useGet: <N extends ServiceNames<S>>(
    serviceName: N,
    resourceId: string | number,
    params?: ServiceQuery<S, N>,
  ) => QueryResult<ServiceItem<S, N>>

  useFind: <N extends ServiceNames<S>>(
    serviceName: N,
    params?: ServiceQuery<S, N>,
  ) => QueryResult<ServiceItem<S, N>[]>

  useMutation: <N extends ServiceNames<S>>(
    serviceName: N,
  ) => UseMutationResult<ServiceItem<S, N>, ServiceMethods<S, N>>
}

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
export function createHooks<S extends Schema>(): TypedHooks<S> {
  // The internal implementations are weakly typed with `string` for serviceName.
  // The strong typing is enforced by the `TypedHooks<S>` return type signature,
  // which correctly narrows the types based on the literal service name provided.

  function useTypedGet(
    serviceName: string,
    resourceId: string | number,
    params?: Record<string, unknown>,
  ) {
    const figbird = useFigbird<S>()
    const service = findServiceByName(figbird.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    const { desc, config } = splitConfig({
      serviceName: actualServiceName,
      method: 'get',
      resourceId,
      ...params,
    })
    // The generic here is not strictly necessary for the implementation but helps
    // align it with the expected return type, reducing the need for `as any`.
    return useQuery(desc, config)
  }

  function useTypedFind(serviceName: string, params?: Record<string, unknown>) {
    const figbird = useFigbird<S>()
    const service = findServiceByName(figbird.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    const { desc, config } = splitConfig({
      serviceName: actualServiceName,
      method: 'find',
      ...params,
    })
    return useQuery(desc, config)
  }

  function useTypedMutation(serviceName: string) {
    const figbird = useFigbird<S>()
    const service = findServiceByName(figbird.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    return useBaseMutation(actualServiceName)
  }

  return {
    useGet: useTypedGet as TypedHooks<S>['useGet'],
    useFind: useTypedFind as TypedHooks<S>['useFind'],
    useMutation: useTypedMutation as unknown as TypedHooks<S>['useMutation'],
  }
}
