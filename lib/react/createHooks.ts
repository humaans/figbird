import { useMemo } from 'react'
import type { AdapterFindMeta, AdapterParams } from '../adapters/adapter.js'
import type {
  FeathersClient,
  TypedFeathersClient,
  TypedFeathersService,
} from '../adapters/feathers.js'
import {
  defineQuery as baseDefineQuery,
  type Figbird,
  type MutationsProxy,
  type PreparedQuery,
  type QueryConfig,
} from '../core/figbird.js'
import { createMutationsProxy, type MutationsHost } from '../core/mutations.js'
import {
  createQueryBuilderProxy,
  type AnyQueryBuilder,
  type QueryBuilderProxy,
} from '../core/queryBuilder.js'
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
import { useMutationImpl, type UseMutationResult } from './useMutation.js'
import { useFindImpl, useGetImpl, type QueryResult } from './useQueryByDesc.js'
import { useQueriesImpl, type UseQueriesHook, type UseQueriesOptions } from './useQueries.js'
import { useQueryImpl, type UseQueryHook, type UseQueryOptions } from './useQuery.js'
import type { ArgsAndOptions, DefineQuery, QueryDefinition } from '../core/figbird.js'

// NODE_ENV probe without depending on @types/node — the library targets browsers,
// so its build must not need node globals to type-check. Emits nothing; bundlers
// still see the same `process.env.NODE_ENV` expression, and the typeof guard at
// the use site covers bare browsers.
declare const process: { env?: { NODE_ENV?: string } } | undefined

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

type UseMutatingForSchema<S extends Schema> = (
  filter?: Omit<UseMutatingFilter, 'service'> & { service?: ServiceNames<S> },
) => boolean

type UseFeathersForSchema<S extends Schema> = () => TypedFeathersClient<S>

/** Schema-typed defineQuery: builders must come from this schema. Name optional. */
type DefineQueryForSchema<S extends Schema> = DefineQuery<AnyQueryBuilder<S>>

type PrepareForSchema<S extends Schema> = <Args, B extends AnyQueryBuilder<S>>(
  query: QueryDefinition<Args, B>,
  ...rest: ArgsAndOptions<Args, { staleTime?: number }>
) => PreparedQuery

type PrefetchForSchema<S extends Schema> = <Args, B extends AnyQueryBuilder<S>>(
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
 * Bind hooks and schema-only helpers without constructing the default Figbird
 * instance during module evaluation. Hooks prefer a FigbirdProvider when one is
 * present; imperative APIs resolve this default when they are called.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export interface CreateHooksOptions<F extends Figbird<any, any>> {
  schema: InferSchema<F>
  /** Return the stable default instance to use outside a provider. */
  getDefaultFigbird: () => F
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export interface FigbirdHooks<F extends Figbird<any, any>> {
  useGet: UseGetForSchema<InferSchema<F>, InferParams<F>>
  useFind: UseFindForSchema<InferSchema<F>, InferParams<F>, InferMeta<F>>
  /**
   * @deprecated Superseded by the split write-side story: `m` for the stateless
   * service handle, `useAction` for per-action pending/error state, `useMutating`
   * for entity/service-level activity. Fully functional, but its single shared
   * status slot forces hand-rolled state machines on multi-action screens.
   */
  useMutation: UseMutationForSchema<InferSchema<F>>
  useFeathers: UseFeathersForSchema<InferSchema<F>>
  /** Resolve the provider instance, falling back to the configured default. */
  useFigbird: () => F
  useQuery: UseQueryHook<InferSchema<F>>
  useQueries: UseQueriesHook<InferSchema<F>>
  q: QueryBuilderProxy<InferSchema<F>>
  defineQuery: DefineQueryForSchema<InferSchema<F>>
  prepare: PrepareForSchema<InferSchema<F>>
  prefetch: PrefetchForSchema<InferSchema<F>>
  /** Manual refetch escape hatch for eventless changes (see `figbird.refetch`). */
  refetch: (serviceName?: ServiceNames<InferSchema<F>> | (string & {})) => void
  /** Write proxy bound to the configured default instance. */
  m: MutationsProxy<InferSchema<F>>
  /** Write proxy resolved from the provider, falling back to the configured default. */
  useM: () => MutationsProxy<InferSchema<F>>
  useAction: UseActionHook
  useMutating: UseMutatingForSchema<InferSchema<F>>
}

/**
 * Creates typed hooks for a specific schema and default Figbird instance.
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
 *
 * To keep module evaluation side-effect free, bind the schema eagerly and the
 * default instance through a getter:
 *
 * ```typescript
 * export const { useQuery, q, m } = createHooks({
 *   schema,
 *   getDefaultFigbird: () => getRuntime().figbird,
 * })
 * ```
 */

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export function createHooks<F extends Figbird<any, any>>(figbird: F): FigbirdHooks<F>
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export function createHooks<F extends Figbird<any, any>>(
  options: CreateHooksOptions<F>,
): FigbirdHooks<F>
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export function createHooks<F extends Figbird<any, any>>(
  input: F | CreateHooksOptions<F>,
): FigbirdHooks<F> {
  type S = InferSchema<F>
  type TParams = InferParams<F>
  type TMeta = InferMeta<F>

  const options = 'getDefaultFigbird' in input ? input : undefined
  const boundFigbird = options ? undefined : input
  const getDefaultFigbird = options?.getDefaultFigbird ?? (() => boundFigbird as F)
  const queryBuilderProxy = options ? createQueryBuilderProxy(options.schema) : undefined

  const lazyMutationsHost: MutationsHost = {
    mutate: desc => {
      const figbird = getDefaultFigbird()
      return Reflect.apply(figbird.mutateDesc, figbird, [desc]) as Promise<unknown>
    },
    call: (serviceName, method, args) => getDefaultFigbird().call(serviceName, method, ...args),
  }
  const lazyMutationsProxy = options
    ? (createMutationsProxy(lazyMutationsHost) as MutationsProxy<S>)
    : undefined

  // The internal implementations are weakly typed with `string` for serviceName.
  // The strong typing is enforced by the return type signature,
  // which correctly narrows the types based on the literal service name provided.

  /**
   * Resolve the instance these hooks operate on: a FigbirdProvider, when present,
   * overrides the default instance (per-request SSR trees and tests inject through it);
   * otherwise the configured default is resolved — no provider needed.
   */
  function useBoundFigbird(): F {
    const fromContext = useFigbirdMaybe()
    if (
      fromContext &&
      boundFigbird &&
      (fromContext as unknown) !== (boundFigbird as unknown) &&
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
    return (fromContext ?? getDefaultFigbird()) as F
  }

  function useTypedM(): MutationsProxy<S> {
    return useBoundFigbird().m as MutationsProxy<S>
  }

  function useTypedGet<N extends ServiceNames<S>>(
    serviceName: N,
    resourceId: string | number,
    params?: WithServiceQuery<S, N, TParams> &
      Partial<QueryConfig<ServiceItem<S, N>, ServiceQuery<S, N>>>,
  ) {
    // Publicly expose get without meta by default
    return useGetImpl<ServiceItem<S, N>, TMeta, ServiceQuery<S, N>>(
      useBoundFigbird(),
      serviceName as string,
      resourceId,
      params || {},
    ) as unknown as QueryResult<ServiceItem<S, N>>
  }

  function useTypedFind<N extends ServiceNames<S>>(
    serviceName: N,
    params?: WithServiceQuery<S, N, TParams> &
      Partial<QueryConfig<ServiceItem<S, N>[], ServiceQuery<S, N>>>,
  ) {
    return useFindImpl<ServiceItem<S, N>[], TMeta, ServiceQuery<S, N>>(
      useBoundFigbird(),
      serviceName as string,
      params || {},
    )
  }

  function useTypedMutation<N extends ServiceNames<S>>(serviceName: N) {
    return useMutationImpl(useBoundFigbird(), serviceName) as UseMutationResult<
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
    // Resolved like every other hook: a FigbirdProvider in the tree overrides the
    // default, so SSR/test injection gets the provider instance's client too.
    const bound = useBoundFigbird()
    const adapter = bound.adapter as { feathers?: FeathersClient }
    if (!adapter?.feathers) {
      throw new Error('useFeathers must be used with a Feathers adapter')
    }
    const { feathers } = adapter
    const schema = bound.schema

    return useMemo(
      () =>
        new Proxy(feathers, {
          get(target, prop, receiver) {
            if (prop === 'service') {
              return <N extends ServiceNames<S>>(serviceName: N) =>
                target.service(
                  resolveServicePath(schema, serviceName),
                ) as unknown as TypedServiceForSchema<S, N>
            }

            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }) as unknown as TypedFeathersClient<S>,
      [feathers, schema],
    )
  }

  function useTypedQuery(
    queryOrDefinition: unknown,
    argsOrOptions?: unknown,
    maybeOptions?: UseQueryOptions,
  ) {
    return useQueryImpl(useBoundFigbird(), queryOrDefinition, argsOrOptions, maybeOptions)
  }

  function useTypedQueries(queries: readonly AnyQueryBuilder[], options?: UseQueriesOptions) {
    return useQueriesImpl(useBoundFigbird(), queries, options)
  }

  const prepare = ((...args: unknown[]) => {
    const figbird = getDefaultFigbird()
    return Reflect.apply(figbird.prepare, figbird, args)
  }) as PrepareForSchema<S>

  const prefetch = ((...args: unknown[]) => {
    const figbird = getDefaultFigbird()
    return Reflect.apply(figbird.prefetch, figbird, args)
  }) as PrefetchForSchema<S>

  const refetch = (serviceName?: ServiceNames<S> | (string & {})) =>
    getDefaultFigbird().refetch(serviceName)

  return {
    useGet: useTypedGet as UseGetForSchema<S, TParams>,
    useFind: useTypedFind as UseFindForSchema<S, TParams, TMeta>,
    useMutation: useTypedMutation as UseMutationForSchema<S>,
    useFeathers: useTypedFeathers as UseFeathersForSchema<S>,
    useFigbird: useBoundFigbird,
    // The typed schema binding is enforced via QueryBuilder<S, T> on the call signatures.
    useQuery: useTypedQuery as unknown as UseQueryHook<S>,
    useQueries: useTypedQueries as unknown as UseQueriesHook<S>,
    // `useQuery(q.issues.where(...))` with one import. The lazy form builds directly
    // from its schema; the eager form defers schemaless errors until q is accessed.
    get q(): QueryBuilderProxy<S> {
      return queryBuilderProxy ?? (getDefaultFigbird().q as QueryBuilderProxy<S>)
    },
    // defineQuery is a pure factory — included so declaration files import everything
    // from one place, and typed so builders must come from this schema.
    defineQuery: baseDefineQuery as DefineQueryForSchema<S>,
    // Instance-bound conveniences resolve the default only when called.
    prepare,
    prefetch,
    // Manual refetch escape hatch for eventless changes (see figbird.refetch).
    refetch,
    // The write proxy — not a hook; callable anywhere and bound to the configured
    // default (a provider override cannot reach non-hooks). useM is context-aware.
    get m(): MutationsProxy<S> {
      return lazyMutationsProxy ?? (getDefaultFigbird().m as MutationsProxy<S>)
    },
    useM: useTypedM,
    // Per-action state, reporting action:* events through the bound instance so
    // devtools speak the app's vocabulary.
    useAction: useTypedAction as UseActionHook,
    useMutating: useTypedMutating as UseMutatingForSchema<S>,
  }
}
