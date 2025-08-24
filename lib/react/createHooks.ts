import { splitConfig } from '../core/figbird.js'
import type { Schema, ServiceNames, ServiceQuery } from '../schema/types.js'
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
  // Create a mapped type that narrows based on the literal string
  type FindSignature = <N extends ServiceNames<S>>(
    serviceName: N,
    params?: ServiceQuery<S, N>,
  ) => QueryResult<Array<S['services'][N] extends Service<infer I, any, any, any> ? I : never>>

  type GetSignature = <N extends ServiceNames<S>>(
    serviceName: N,
    resourceId: string | number,
    params?: ServiceQuery<S, N>,
  ) => QueryResult<S['services'][N] extends Service<infer I, any, any, any> ? I : never>

  type MutationSignature = <N extends ServiceNames<S>>(
    serviceName: N,
  ) => UseMutationResult<
    S['services'][N] extends Service<infer I, any, any, any> ? I : never,
    S['services'][N] extends Service<any, any, infer M, any> ? M : Record<string, never>
  >

  const useTypedGet: GetSignature = (serviceName, resourceId, params) => {
    const figbird = useFigbird<S>()
    const service = findServiceByName(figbird.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    const { desc, config } = splitConfig({
      serviceName: actualServiceName,
      method: 'get',
      resourceId,
      ...params,
    })
    return useQuery(desc, config)
  }

  const useTypedFind: FindSignature = (serviceName, params) => {
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

  const useTypedMutation: MutationSignature = serviceName => {
    const figbird = useFigbird<S>()
    const service = findServiceByName(figbird.schema, serviceName)
    const actualServiceName = service?.name ?? serviceName
    return useBaseMutation(actualServiceName) as any
  }

  return {
    useGet: useTypedGet,
    useFind: useTypedFind,
    useMutation: useTypedMutation,
  }
}

// Re-export Service for convenience
import type { Service } from '../schema/types.js'
