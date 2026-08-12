import { useMemo } from 'react'
import type { Adapter, AdapterFindMeta, AdapterParams } from '../adapters/adapter.js'
import type {
  FeathersClient,
  TypedFeathersClient,
  TypedFeathersService,
} from '../adapters/feathers.js'
import {
  defineQuery as baseDefineQuery,
  type DefineQuery,
  type Figbird,
  type MutationsProxy,
  type QueryConfig,
} from '../core/figbird.js'
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
import { useFigbird as useContextFigbird } from './context.js'
import { useAction, type UseActionHook } from './useAction.js'
import { useMutatingImpl, type UseMutatingFilter } from './useMutating.js'
import { useMutation, type UseMutationResult } from './useMutation.js'
import { useFind, useGet, type QueryResult } from './useQueryByDesc.js'
import { useQueries, type UseQueriesHook } from './useQueries.js'
import { useQuery, type UseQueryHook } from './useQuery.js'

/**
 * Strongly-typed call signatures per service name.
 * Using a union of call signatures (one per service) gives the best inference:
 * passing a literal service name narrows the return type to that service.
 */
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

export interface FigbirdHooks<S extends Schema, A extends Adapter = Adapter> {
  useGet: UseGetForSchema<S, AdapterParams<A>>
  useFind: UseFindForSchema<S, AdapterParams<A>, AdapterFindMeta<A>>
  /**
   * @deprecated Superseded by the split write-side story: `useMutations` for
   * stateless service commands, `useAction` for per-action pending/error state,
   * and `useMutating` for entity/service-level activity.
   */
  useMutation: UseMutationForSchema<S>
  useFeathers: UseFeathersForSchema<S>
  /** Return the Figbird instance supplied by the nearest provider. */
  useFigbird: () => Figbird<S, A>
  useQuery: UseQueryHook<S>
  useQueries: UseQueriesHook<S>
  q: QueryBuilderProxy<S>
  defineQuery: DefineQueryForSchema<S>
  /** Return the mutation commands for the Figbird instance supplied by the provider. */
  useMutations: () => MutationsProxy<S>
  useAction: UseActionHook
  useMutating: UseMutatingForSchema<S>
}

/**
 * Create import-safe, schema-typed React bindings.
 *
 * The schema is pure configuration, so binding it here has no runtime side
 * effects. Hooks resolve their Figbird instance from `FigbirdProvider`, which
 * lets applications, tests, stories, and SSR requests inject the right runtime.
 * Imperative work outside React uses the instance directly (`figbird.m`,
 * `figbird.prepare`, and so on).
 *
 * ```typescript
 * export const { useQuery, q, useMutations } = createHooks(schema)
 *
 * function People() {
 *   const m = useMutations()
 *   const { data: people } = useQuery(q.people)
 * }
 * ```
 *
 * The adapter generic is optional and only needed when legacy hooks should
 * expose adapter-specific params or metadata:
 *
 * ```typescript
 * createHooks<typeof schema, FeathersAdapter>(schema)
 * ```
 */
export function createHooks<S extends Schema, A extends Adapter = Adapter>(
  schema: S,
): FigbirdHooks<S, A> {
  type TParams = AdapterParams<A>
  type TMeta = AdapterFindMeta<A>

  const q = createQueryBuilderProxy(schema)

  function useBoundFigbird(): Figbird<S, A> {
    const figbird = useContextFigbird<S, A>()
    if (figbird.schema !== schema) {
      throw new Error(
        'The FigbirdProvider instance uses a different schema from createHooks(schema)',
      )
    }
    return figbird
  }

  function useTypedMutations(): MutationsProxy<S> {
    return useBoundFigbird().m
  }

  function useTypedMutating(filter?: UseMutatingFilter): boolean {
    return useMutatingImpl(useBoundFigbird(), filter)
  }

  function useTypedFeathers() {
    const adapter = useBoundFigbird().adapter as { feathers?: FeathersClient }
    if (!adapter.feathers) {
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
                  resolveServicePath(schema, serviceName),
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
    useGet: useGet as unknown as UseGetForSchema<S, TParams>,
    useFind: useFind as unknown as UseFindForSchema<S, TParams, TMeta>,
    useMutation: useMutation as unknown as UseMutationForSchema<S>,
    useFeathers: useTypedFeathers as UseFeathersForSchema<S>,
    useFigbird: useBoundFigbird,
    useQuery: useQuery as UseQueryHook<S>,
    useQueries: useQueries as UseQueriesHook<S>,
    q,
    defineQuery: baseDefineQuery as DefineQueryForSchema<S>,
    useMutations: useTypedMutations,
    useAction,
    useMutating: useTypedMutating as UseMutatingForSchema<S>,
  }
}
