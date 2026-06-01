import { useMemo } from 'react'
import type { AdapterFindMeta, AdapterParams } from '../adapters/adapter.js'
import type {
  FeathersClient,
  TypedFeathersClient,
  TypedFeathersService,
} from '../adapters/feathers.js'
import type { Figbird } from '../core/figbird.js'
import { splitConfig, type QueryConfig } from '../core/queryTypes.js'
import type {
  Schema,
  ServiceCreate,
  ServiceItem,
  ServiceMethods,
  ServiceNames,
  ServicePatch,
  ServiceQuery,
  ServiceUpdate,
} from '../core/schema.js'
import { resolveServicePath } from '../core/schema.js'
import { useMethod as useBaseMethod, type UseMethodResult } from './useMethod.js'
import { useMutation as useBaseMutation, type UseMutationResult } from './useMutation.js'
import { useQuery, type QueryResult } from './useQuery.js'

/**
 * Strongly-typed call signatures per service name.
 * Using a union of call signatures (one per service) gives the best inference:
 * passing a literal service name narrows the return type to that service.
 */
// Narrow adapter params `query` by the service domain query type while preserving adapter controls
type WithServiceQuery<S extends Schema, N extends ServiceNames<S>, TParams> = Omit<
  TParams,
  'query'
> & { query?: ServiceQuery<S, N> }

type UseGetForSchema<S extends Schema, TParams = unknown> = <N extends ServiceNames<S>>(
  serviceName: N,
  resourceId: string | number,
  params?: WithServiceQuery<S, N, TParams> &
    Partial<QueryConfig<ServiceItem<S, N>, ServiceQuery<S, N>>>,
) => QueryResult<ServiceItem<S, N>>

type UseFindForSchema<
  S extends Schema,
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> = <N extends ServiceNames<S>>(
  serviceName: N,
  params?: WithServiceQuery<S, N, TParams> &
    Partial<QueryConfig<ServiceItem<S, N>[], ServiceQuery<S, N>>>,
) => QueryResult<ServiceItem<S, N>[], TMeta>

type UseMutationForSchema<S extends Schema> = <N extends ServiceNames<S>>(
  serviceName: N,
) => UseMutationResult<
  ServiceItem<S, N>,
  ServiceCreate<S, N>,
  ServiceUpdate<S, N>,
  ServicePatch<S, N>
>

type TypedServiceForSchema<S extends Schema, N extends ServiceNames<S>> = TypedFeathersService<
  ServiceItem<S, N>,
  ServiceCreate<S, N>,
  ServiceUpdate<S, N>,
  ServicePatch<S, N>,
  ServiceQuery<S, N>,
  ServiceMethods<S, N>
>

type UseServiceForSchema<S extends Schema> = <N extends ServiceNames<S>>(
  serviceName: N,
) => TypedServiceForSchema<S, N>

type MethodArgs<TMethod> = TMethod extends (...args: infer TArgs extends unknown[]) => unknown
  ? TArgs
  : never

type MethodData<TMethod> = TMethod extends (...args: infer TArgs extends unknown[]) => infer TResult
  ? TArgs extends unknown[]
    ? Awaited<TResult>
    : never
  : never

type UseMethodForSchema<S extends Schema> = <
  N extends ServiceNames<S>,
  M extends keyof ServiceMethods<S, N> & string,
>(
  serviceName: N,
  methodName: M,
) => UseMethodResult<MethodArgs<ServiceMethods<S, N>[M]>, MethodData<ServiceMethods<S, N>[M]>>

type UseFeathersForSchema<S extends Schema> = () => TypedFeathersClient<S>

// Type helper to extract schema and adapter types from a Figbird instance
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type InferSchema<F> = F extends Figbird<infer S, any> ? S : never
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type InferAdapter<F> = F extends Figbird<any, infer A> ? A : never
type InferParams<F> = AdapterParams<InferAdapter<F>>
type InferMeta<F> = AdapterFindMeta<InferAdapter<F>>

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
 *   const people = useFind('people') // Fully typed to QueryResult<Person[], FeathersFindMeta>
 *   const peopleService = useService('people') // Fully typed Feathers service
 * }
 * ```
 */

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export function createHooks<F extends Figbird<any, any>>(
  figbird: F,
): {
  useGet: UseGetForSchema<InferSchema<F>, InferParams<F>>
  useFind: UseFindForSchema<InferSchema<F>, InferParams<F>, InferMeta<F>>
  useMutation: UseMutationForSchema<InferSchema<F>>
  useService: UseServiceForSchema<InferSchema<F>>
  useMethod: UseMethodForSchema<InferSchema<F>>
  useFeathers: UseFeathersForSchema<InferSchema<F>>
} {
  type S = InferSchema<F>
  type TParams = InferParams<F>
  type TMeta = InferMeta<F>

  // The internal implementations are weakly typed with `string` for serviceName.
  // The strong typing is enforced by the return type signature,
  // which correctly narrows the types based on the literal service name provided.

  function useTypedGet<N extends ServiceNames<S>>(
    serviceName: N,
    resourceId: string | number,
    params?: WithServiceQuery<S, N, TParams> &
      Partial<QueryConfig<ServiceItem<S, N>, ServiceQuery<S, N>>>,
  ) {
    const combinedConfig = Object.assign(
      { serviceName, method: 'get' as const, resourceId },
      params || {},
    )
    const { desc, config } = splitConfig<ServiceItem<S, N>, ServiceQuery<S, N>>(combinedConfig)
    // Publicly expose get without meta by default
    return useQuery<ServiceItem<S, N>, TMeta, ServiceQuery<S, N>>(
      desc,
      config,
    ) as unknown as QueryResult<ServiceItem<S, N>>
  }

  function useTypedFind<N extends ServiceNames<S>>(
    serviceName: N,
    params?: WithServiceQuery<S, N, TParams> &
      Partial<QueryConfig<ServiceItem<S, N>[], ServiceQuery<S, N>>>,
  ) {
    const combinedConfig = Object.assign({ serviceName, method: 'find' as const }, params || {})
    const { desc, config } = splitConfig<ServiceItem<S, N>[], ServiceQuery<S, N>>(combinedConfig)
    return useQuery<ServiceItem<S, N>[], TMeta, ServiceQuery<S, N>>(desc, config)
  }

  function useTypedMutation<N extends ServiceNames<S>>(serviceName: N) {
    return useBaseMutation(serviceName) as UseMutationResult<
      ServiceItem<S, N>,
      ServiceCreate<S, N>,
      ServiceUpdate<S, N>,
      ServicePatch<S, N>
    >
  }

  function useTypedService<N extends ServiceNames<S>>(serviceName: N) {
    const adapter = figbird.adapter as { feathers?: FeathersClient }
    if (!adapter?.feathers) {
      throw new Error('useService must be used with a Feathers adapter')
    }

    return adapter.feathers.service(
      resolveServicePath(figbird.schema, serviceName),
    ) as unknown as TypedServiceForSchema<S, N>
  }

  function useTypedMethod<N extends ServiceNames<S>, M extends keyof ServiceMethods<S, N> & string>(
    serviceName: N,
    methodName: M,
  ) {
    return useBaseMethod<MethodArgs<ServiceMethods<S, N>[M]>, MethodData<ServiceMethods<S, N>[M]>>(
      serviceName,
      methodName,
    )
  }

  function useTypedFeathers() {
    const adapter = figbird.adapter as { feathers?: FeathersClient }
    if (!adapter?.feathers) {
      throw new Error('useFeathers must be used with a Feathers adapter')
    }
    const { feathers } = adapter

    return useMemo(
      () =>
        new Proxy(feathers, {
          get(target, prop, receiver) {
            if (prop === 'service') {
              return <N extends ServiceNames<S>>(serviceName: N) =>
                target.service(
                  resolveServicePath(figbird.schema, serviceName),
                ) as unknown as TypedServiceForSchema<S, N>
            }

            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }) as unknown as TypedFeathersClient<S>,
      [feathers],
    )
  }

  return {
    useGet: useTypedGet as UseGetForSchema<S, TParams>,
    useFind: useTypedFind as UseFindForSchema<S, TParams, TMeta>,
    useMutation: useTypedMutation as UseMutationForSchema<S>,
    useService: useTypedService as UseServiceForSchema<S>,
    useMethod: useTypedMethod as UseMethodForSchema<S>,
    useFeathers: useTypedFeathers as UseFeathersForSchema<S>,
  }
}
