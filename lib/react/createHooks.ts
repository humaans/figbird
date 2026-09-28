import type { Adapter, AdapterFindMeta, AdapterParams } from '../adapters/adapter.js'
import type { FeathersClient, TypedFeathersClient } from '../adapters/feathers.js'
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
import type { Schema, ServiceDefinitionByPath, ServiceNames, ServicePaths } from '../core/schema.js'
import { useFigbird as useContextFigbird } from './context.js'
import { useAction, type UseActionHook } from './useAction.js'
import { useMutatingImpl, type UseMutatingFilter } from './useMutating.js'
import { useMutation, type UseMutationResult } from './useMutation.js'
import { useMutationQueueImpl, type UseMutationQueueHook } from './useMutationQueue.js'
import type { MutationQueueDefinition } from '../core/mutationQueue.js'
import { useFind, useGet, type QueryResult } from './useQueryByDesc.js'
import {
  useQueries,
  useQueryResults,
  type UseQueriesHook,
  type UseQueryResultsHook,
} from './useQueries.js'
import { useQuery, useQueryResult, type UseQueryHook, type UseQueryResultHook } from './useQuery.js'
import { useWindowQuery, type UseWindowQueryHook } from './useWindowQuery.js'

/**
 * Strongly-typed legacy call signatures per transport path.
 * Using a union of call signatures (one per service) gives the best inference:
 * passing a literal service path narrows the return type to that service.
 */
type WithServiceQuery<S extends Schema, P extends ServicePaths<S>, TParams> = Omit<
  TParams,
  'query'
> & { query?: ServiceDefinitionByPath<S, P>['query'] }

type UseGetForSchema<S extends Schema, TParams = unknown> = <P extends ServicePaths<S>>(
  servicePath: P,
  resourceId: string | number,
  params?: WithServiceQuery<S, P, TParams> &
    Partial<
      QueryConfig<ServiceDefinitionByPath<S, P>['item'], ServiceDefinitionByPath<S, P>['query']>
    >,
) => QueryResult<ServiceDefinitionByPath<S, P>['item']>

type UseFindForSchema<
  S extends Schema,
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> = <P extends ServicePaths<S>>(
  servicePath: P,
  params?: WithServiceQuery<S, P, TParams> &
    Partial<
      QueryConfig<ServiceDefinitionByPath<S, P>['item'][], ServiceDefinitionByPath<S, P>['query']>
    >,
) => QueryResult<ServiceDefinitionByPath<S, P>['item'][], TMeta>

type UseMutationForSchema<S extends Schema> = <P extends ServicePaths<S>>(
  servicePath: P,
) => UseMutationResult<
  ServiceDefinitionByPath<S, P>['item'],
  ServiceDefinitionByPath<S, P>['create'],
  ServiceDefinitionByPath<S, P>['update'],
  ServiceDefinitionByPath<S, P>['patch']
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
  useQueryResult: UseQueryResultHook<S>
  /** Query a bounded, viewport-indexed relational list. */
  useWindowQuery: UseWindowQueryHook<S>
  useQueries: UseQueriesHook<S>
  useQueryResults: UseQueryResultsHook<S>
  q: QueryBuilderProxy<S>
  defineQuery: DefineQueryForSchema<S>
  /** Return the mutation commands for the Figbird instance supplied by the provider. */
  useMutations: () => MutationsProxy<S>
  useAction: UseActionHook
  useMutating: UseMutatingForSchema<S>
  useMutationQueue: UseMutationQueueHook<S>
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
 *   const people = useQuery(q.people)
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

  function useTypedMutationQueue(definition?: MutationQueueDefinition, key?: string) {
    return useMutationQueueImpl(useBoundFigbird(), definition, key)
  }
  function useTypedFeathers(): TypedFeathersClient<S> {
    const adapter = useBoundFigbird().adapter as { feathers?: FeathersClient }
    if (!adapter.feathers) {
      throw new Error('useFeathers must be used with a Feathers adapter')
    }

    return adapter.feathers as unknown as TypedFeathersClient<S>
  }

  return {
    useGet: useGet as unknown as UseGetForSchema<S, TParams>,
    useFind: useFind as unknown as UseFindForSchema<S, TParams, TMeta>,
    useMutation: useMutation as unknown as UseMutationForSchema<S>,
    useFeathers: useTypedFeathers,
    useFigbird: useBoundFigbird,
    useQuery: useQuery as UseQueryHook<S>,
    useQueryResult: useQueryResult as UseQueryResultHook<S>,
    useWindowQuery: useWindowQuery as UseWindowQueryHook<S>,
    useQueries: useQueries as UseQueriesHook<S>,
    useQueryResults: useQueryResults as UseQueryResultsHook<S>,
    q,
    defineQuery: baseDefineQuery as DefineQueryForSchema<S>,
    useMutations: useTypedMutations,
    useAction,
    useMutating: useTypedMutating as UseMutatingForSchema<S>,
    useMutationQueue: useTypedMutationQueue as UseMutationQueueHook<S>,
  }
}
