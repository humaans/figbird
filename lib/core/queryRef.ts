import { createQueryId } from './queryIdentity.js'
import type { AnySchema, Schema } from './schema.js'
import type { QueryStore } from './queryStore.js'
import type {
  ProcessedCacheEvent,
  QueryConfig,
  QueryDescriptor,
  QueryExecutionOptions,
  QueryState,
} from './queryTypes.js'

// a lightweight query reference object to make it easy
// subscribe to state changes and read query data
// this is only a ref and does not contain state itself, it instead
// references all the state from the shared figbird query state
/**
 * Lightweight reference to a query in the shared Figbird store.
 * Provides helpers to subscribe to updates, get snapshots, and refetch.
 */
export class QueryRef<
  T,
  TQueryType = unknown,
  S extends Schema = AnySchema,
  TParams = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TQuery = Record<string, unknown>,
> {
  #queryId: string
  #desc: QueryDescriptor
  #config: QueryConfig<T, TQueryType>
  #queryStore: QueryStore<S, TParams, TMeta, TQuery>

  constructor({
    desc,
    config,
    queryStore,
  }: {
    desc: QueryDescriptor
    config: QueryConfig<T, TQueryType>
    queryStore: QueryStore<S, TParams, TMeta, TQuery>
  }) {
    this.#queryId = createQueryId(desc, config)
    this.#desc = desc
    this.#config = config
    this.#queryStore = queryStore
  }

  /** Returns internal details of this query reference (for debugging/testing). */
  details(): { queryId: string; desc: QueryDescriptor; config: QueryConfig<T, TQueryType> } {
    return {
      queryId: this.#queryId,
      desc: this.#desc,
      config: this.#config,
    }
  }

  /** Returns a stable hash representing descriptor + config. */
  hash(): string {
    return this.#queryId
  }

  /**
   * Subscribes to this query's state. Triggers fetching if needed.
   * Returns an unsubscribe function.
   */
  subscribe(
    fn: (state: QueryState<T, TMeta>) => void,
    options?: QueryExecutionOptions,
  ): () => void {
    this.#queryStore.materialize(this)
    return this.#queryStore.subscribe<T>(this.#queryId, fn, options)
  }

  /**
   * Re-run the store's subscribe-time freshness check without adding a listener.
   * Relational refs use this when a stricter subscriber joins an already-live tree.
   */
  ensureFresh(options?: QueryExecutionOptions): void {
    this.#queryStore.materialize(this)
    this.#queryStore.ensureFresh(this.#queryId, options)
  }

  /** Returns the latest known state for this query, if available. */
  getSnapshot(): QueryState<T, TMeta> | undefined {
    this.#queryStore.materialize(this)
    return this.#queryStore.getQueryState<T>(this.#queryId)
  }

  /** Triggers a refetch for this query. */
  refetch(options?: Omit<QueryExecutionOptions, 'staleTime'>): void {
    this.#queryStore.materialize(this)
    return this.#queryStore.refetch(this.#queryId, undefined, options)
  }

  /** Route an event-driven refetch through the store's reconciliation gate. @internal */
  reconcile(): void {
    this.#queryStore.materialize(this)
    this.#queryStore.reconcile(this.#queryId)
  }

  /** Apply a value-only update to an already-visible row. @internal */
  applyVisibleEvent(event: ProcessedCacheEvent): void {
    this.#queryStore.materialize(this)
    this.#queryStore.applyVisibleEvent(this.#queryId, event)
  }

  /** Register this ref as a composite query's reconnect sentinel. @internal */
  registerReconnectReconciliation(): () => void {
    this.#queryStore.materialize(this)
    return this.#queryStore.registerReconnectQuery(this.#queryId)
  }
}
