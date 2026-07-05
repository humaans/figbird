import { useMemo } from 'react'
import type { AdapterFindMeta, AdapterParams } from '../adapters/adapter.js'
import type {
  FeathersClient,
  TypedFeathersClient,
  TypedFeathersService,
} from '../adapters/feathers.js'
import {
  defineQuery as baseDefineQuery,
  splitConfig,
  type Figbird,
  type MutationsProxy,
  type PreparedQuery,
  type QueryConfig,
  type StandardSchemaV1,
} from '../core/figbird.js'
import type { QueryBuilder, QueryBuilderKind } from '../core/queryBuilder.js'
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
import { useFigbirdMaybe } from './context.js'
import { useActionImpl, type UseActionHook, type UseActionResult } from './useAction.js'
import { useMutatingImpl, type UseMutatingFilter } from './useMutating.js'
import { useMutationImpl, type UseMutationOptions, type UseMutationResult } from './useMutation.js'
import { useQueryByDescImpl, type QueryResult } from './useQueryByDesc.js'
import { useQueryImpl, type FigbirdLike } from './useQuery.js'
import type {
  RelationalQueryResult,
  SkipAware,
  SuspenseQueryResult,
  UseQueryOptions,
} from './useQuery.js'
import type { ArgsAndOptions, ArgsAndRequiredOptions, QueryDefinition } from '../core/figbird.js'
import type { QueryBuilderProxy, QueryBuilderResult } from '../core/queryBuilder.js'

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
  options?: UseMutationOptions,
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

type UseMutatingForSchema<S extends Schema> = (
  filter?: Omit<UseMutatingFilter, 'service'> & { service?: ServiceNames<S> },
) => boolean

type UseFeathersForSchema<S extends Schema> = () => TypedFeathersClient<S>

interface UseQueryForSchema<S extends Schema> {
  // Builder, non-suspense — returns the tagged union, never throws
  <
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(
    query: B,
    options: UseQueryOptions & { suspense: false },
  ): RelationalQueryResult<QueryBuilderResult<B>>
  // Definition, non-suspense — args omittable when the definition takes none
  <
    Args,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(
    definition: QueryDefinition<Args, B>,
    ...rest: ArgsAndRequiredOptions<Args, UseQueryOptions & { suspense: false }>
  ): RelationalQueryResult<QueryBuilderResult<B>>
  // Builder
  <
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
    O extends UseQueryOptions = Record<string, never>,
  >(
    query: B,
    options?: O,
  ): SuspenseQueryResult<SkipAware<QueryBuilderResult<B>, O>, QueryBuilderKind<B>>
  // Definition — args omittable when the definition takes none
  <
    Args,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
    O extends UseQueryOptions = Record<string, never>,
  >(
    definition: QueryDefinition<Args, B>,
    ...rest: ArgsAndOptions<Args, O>
  ): SuspenseQueryResult<SkipAware<QueryBuilderResult<B>, O>, QueryBuilderKind<B>>
}

/** Schema-typed defineQuery: builders must come from this schema. Name optional. */
interface DefineQueryForSchema<S extends Schema> {
  <
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(
    build: () => B,
  ): QueryDefinition<void, B>
  <
    Args,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(
    build: (args: Args) => B,
  ): QueryDefinition<Args, B>
  <
    TSchema extends StandardSchemaV1,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(
    argsSchema: TSchema,
    build: (args: StandardSchemaV1.InferOutput<TSchema>) => B,
  ): QueryDefinition<StandardSchemaV1.InferOutput<TSchema>, B>
  <
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(
    name: string,
    build: () => B,
  ): QueryDefinition<void, B>
  <
    Args,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(
    name: string,
    build: (args: Args) => B,
  ): QueryDefinition<Args, B>
  <
    TSchema extends StandardSchemaV1,
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    B extends QueryBuilder<S, any, any, any, any, any>,
  >(
    name: string,
    argsSchema: TSchema,
    build: (args: StandardSchemaV1.InferOutput<TSchema>) => B,
  ): QueryDefinition<StandardSchemaV1.InferOutput<TSchema>, B>
}

type PrepareForSchema<S extends Schema> = <
  Args,
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  B extends QueryBuilder<S, any, any, any, any, any>,
>(
  query: QueryDefinition<Args, B>,
  ...rest: ArgsAndOptions<Args, { staleTime?: number }>
) => PreparedQuery

type PrefetchForSchema<S extends Schema> = <
  Args,
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  B extends QueryBuilder<S, any, any, any, any, any>,
>(
  query: QueryDefinition<Args, B>,
  ...rest: ArgsAndOptions<Args, { staleTime?: number }>
) => void

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
 * export const { useQuery, q, m, useAction, useMutating } = createHooks(figbird)
 *
 * // component.tsx
 * import { q, useQuery } from './figbird'
 *
 * function MyComponent() {
 *   const { data: people } = useQuery(q.people) // fully typed from the schema
 * }
 * ```
 */

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export function createHooks<F extends Figbird<any, any>>(
  figbird: F,
): {
  useGet: UseGetForSchema<InferSchema<F>, InferParams<F>>
  useFind: UseFindForSchema<InferSchema<F>, InferParams<F>, InferMeta<F>>
  /**
   * @deprecated Superseded by the split write-side story: `mutations()` for the
   * stateless service handle, `useAction` for per-action pending/error state,
   * `useMutating` for entity/service-level activity. Fully functional, but its
   * single shared status slot forces hand-rolled state machines on multi-action
   * screens.
   */
  useMutation: UseMutationForSchema<InferSchema<F>>
  useFeathers: UseFeathersForSchema<InferSchema<F>>
  useQuery: UseQueryForSchema<InferSchema<F>>
  q: QueryBuilderProxy<InferSchema<F>>
  defineQuery: DefineQueryForSchema<InferSchema<F>>
  prepare: PrepareForSchema<InferSchema<F>>
  prefetch: PrefetchForSchema<InferSchema<F>>
  m: MutationsProxy<InferSchema<F>>
  useAction: UseActionHook
  useMutating: UseMutatingForSchema<InferSchema<F>>
} {
  type S = InferSchema<F>
  type TParams = InferParams<F>
  type TMeta = InferMeta<F>

  // The internal implementations are weakly typed with `string` for serviceName.
  // The strong typing is enforced by the return type signature,
  // which correctly narrows the types based on the literal service name provided.

  /**
   * Resolve the instance these hooks operate on: a FigbirdProvider, when present,
   * overrides the bound instance (per-request SSR trees and tests inject through it);
   * otherwise the instance passed to createHooks is used directly — no provider needed.
   */
  function useBoundFigbird(): F {
    const fromContext = useFigbirdMaybe()
    if (
      fromContext &&
      (fromContext as unknown) !== (figbird as unknown) &&
      typeof process !== 'undefined' &&
      process.env?.NODE_ENV !== 'production'
    ) {
      console.error(
        'figbird: these hooks were created by createHooks() with one Figbird instance, ' +
          'but a <FigbirdProvider> higher in the tree holds a different one. The provider ' +
          'instance wins — if that is not intentional, remove the provider or pass the ' +
          'same instance to both.',
      )
    }
    return (fromContext ?? figbird) as F
  }

  function useTypedGet<N extends ServiceNames<S>>(
    serviceName: N,
    resourceId: string | number,
    params?: WithServiceQuery<S, N, TParams> &
      Partial<QueryConfig<ServiceItem<S, N>, ServiceQuery<S, N>>>,
  ) {
    const combinedConfig = Object.assign(
      // Service path aliases are resolved centrally by figbird.query().
      { serviceName: serviceName as string, method: 'get' as const, resourceId },
      params || {},
    )
    const { desc, config } = splitConfig<ServiceItem<S, N>, ServiceQuery<S, N>>(combinedConfig)
    // Publicly expose get without meta by default
    return useQueryByDescImpl<ServiceItem<S, N>, TMeta, ServiceQuery<S, N>>(
      useBoundFigbird(),
      desc,
      config,
    ) as unknown as QueryResult<ServiceItem<S, N>>
  }

  function useTypedFind<N extends ServiceNames<S>>(
    serviceName: N,
    params?: WithServiceQuery<S, N, TParams> &
      Partial<QueryConfig<ServiceItem<S, N>[], ServiceQuery<S, N>>>,
  ) {
    const combinedConfig = Object.assign(
      // Service path aliases are resolved centrally by figbird.query().
      { serviceName: serviceName as string, method: 'find' as const },
      params || {},
    )
    const { desc, config } = splitConfig<ServiceItem<S, N>[], ServiceQuery<S, N>>(combinedConfig)
    return useQueryByDescImpl<ServiceItem<S, N>[], TMeta, ServiceQuery<S, N>>(
      useBoundFigbird(),
      desc,
      config,
    )
  }

  function useTypedMutation<N extends ServiceNames<S>>(
    serviceName: N,
    options?: UseMutationOptions,
  ) {
    return useMutationImpl(useBoundFigbird(), serviceName, options) as UseMutationResult<
      ServiceItem<S, N>,
      ServiceCreate<S, N>,
      ServiceUpdate<S, N>,
      ServicePatch<S, N>
    >
  }

  function useTypedMutating(filter?: UseMutatingFilter) {
    return useMutatingImpl(useBoundFigbird(), filter)
  }

  function useTypedAction<TArgs extends unknown[], TResult>(
    fnOrName: string | ((...args: TArgs) => Promise<TResult> | TResult),
    maybeFn?: (...args: TArgs) => Promise<TResult> | TResult,
  ): UseActionResult<TArgs, TResult> {
    return useActionImpl(useBoundFigbird(), fnOrName, maybeFn)
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

  function useTypedQuery(
    queryOrDefinition: unknown,
    argsOrOptions?: unknown,
    maybeOptions?: UseQueryOptions,
  ) {
    return useQueryImpl(
      useBoundFigbird() as unknown as FigbirdLike,
      queryOrDefinition,
      argsOrOptions,
      maybeOptions,
    )
  }

  return {
    useGet: useTypedGet as UseGetForSchema<S, TParams>,
    useFind: useTypedFind as UseFindForSchema<S, TParams, TMeta>,
    useMutation: useTypedMutation as UseMutationForSchema<S>,
    useFeathers: useTypedFeathers as UseFeathersForSchema<S>,
    // The typed schema binding is enforced via QueryBuilder<S, T> on the call signatures.
    useQuery: useTypedQuery as unknown as UseQueryForSchema<S>,
    // The builder proxy off the bound instance — `useQuery(q.issues.where(...))` with a
    // single import. Lazy so schemaless instances only throw if actually accessed.
    get q(): QueryBuilderProxy<S> {
      return figbird.q as QueryBuilderProxy<S>
    },
    // defineQuery is a pure factory — included so declaration files import everything
    // from one place, and typed so builders must come from this schema.
    defineQuery: baseDefineQuery as DefineQueryForSchema<S>,
    // Instance-bound conveniences: same primitives as figbird.prepare/prefetch.
    prepare: figbird.prepare.bind(figbird) as PrepareForSchema<S>,
    prefetch: figbird.prefetch.bind(figbird) as PrefetchForSchema<S>,
    // The write proxy — not a hook; callable anywhere. Like prepare/prefetch,
    // bound to the createHooks instance (a provider override can't reach non-hooks).
    get m(): MutationsProxy<S> {
      return figbird.m as MutationsProxy<S>
    },
    // Per-action state, reporting action:* events through the bound instance so
    // devtools speak the app's vocabulary.
    useAction: useTypedAction as UseActionHook,
    useMutating: useTypedMutating as UseMutatingForSchema<S>,
  }
}
