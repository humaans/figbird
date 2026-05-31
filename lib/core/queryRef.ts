import { createQueryId } from './queryIdentity.js'
import type { AnySchema, Schema } from './schema.js'
import type { QueryStore } from './queryStore.js'
import type { QueryConfig, QueryDescriptor, QueryState } from './queryTypes.js'

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
  subscribe(fn: (state: QueryState<T, TMeta>) => void): () => void {
    this.#queryStore.materialize(this)
    return this.#queryStore.subscribe<T>(this.#queryId, fn)
  }

  /** Returns the latest known state for this query, if available. */
  getSnapshot(): QueryState<T, TMeta> | undefined {
    this.#queryStore.materialize(this)
    return this.#queryStore.getQueryState<T>(this.#queryId)
  }

  /** Triggers a refetch for this query. */
  refetch(): void {
    this.#queryStore.materialize(this)
    return this.#queryStore.refetch(this.#queryId)
  }
}
