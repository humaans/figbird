import { hashObject } from './hash'
import type { Schema, ServiceType } from './schema'

type ServiceName<S extends Schema<any>> = keyof S & string

interface AdapterInterface<S extends Schema<any>> {
  matcher: (query: any) => (item: any) => boolean
  getId: (item: any) => string
  isItemStale: (currItem: any, newItem: any) => boolean
  itemRemoved: (meta: any) => any
  itemAdded: (meta: any) => any
  get: <N extends ServiceName<S>>(
    serviceName: N,
    resourceId: string,
    params: any,
  ) => Promise<{ data: ServiceType<S, N>; meta?: any }>
  find: <N extends ServiceName<S>>(
    serviceName: N,
    params: any,
  ) => Promise<{ data: ServiceType<S, N>[]; meta?: any }>
  findAll: <N extends ServiceName<S>>(
    serviceName: N,
    params: any,
  ) => Promise<{ data: ServiceType<S, N>[]; meta?: any }>
  mutate: <N extends ServiceName<S>>(
    serviceName: N,
    method: string,
    args: any[],
  ) => Promise<ServiceType<S, N>>
  subscribe: <N extends ServiceName<S>>(serviceName: N, handlers: any) => () => void
}

interface QueryState<T> {
  data: T | null
  meta?: any
  status: 'idle' | 'loading' | 'success' | 'error'
  isFetching: boolean
  error: Error | null
}

interface QueryConfig {
  skip?: boolean
  realtime?: 'merge' | 'refetch' | 'none'
  fetchPolicy?: 'swr' | 'network-only'
  allPages?: boolean
  matcher?: (query: any, defaultMatcher: (item: any) => boolean) => (item: any) => boolean
}

interface QueryDescriptor<S extends Schema<any>, N extends ServiceName<S>> {
  serviceName: N
  method: string
  resourceId?: string
  params?: any
}

interface Query<S extends Schema<any>, N extends ServiceName<S>, T = ServiceType<S, N>> {
  queryId: string
  desc: QueryDescriptor<S, N>
  config: QueryConfig
  pending: boolean
  filterItem: (item: T) => boolean
  state: QueryState<T>
}

interface Service<T> {
  entities: Map<string, T>
  queries: Map<string, Query<any, any, any>>
  itemQueryIndex: Map<string, Set<string>>
}

export class Figbird<S extends Schema<any>> {
  adapter: AdapterInterface<S>
  schema: S
  queryStore: QueryStore<S>

  constructor({ adapter, schema }: { adapter: AdapterInterface<S>; schema: S }) {
    this.adapter = adapter
    this.schema = schema
    this.queryStore = new QueryStore<S>({ adapter })
  }

  getState() {
    return this.queryStore.getState()
  }

  query<N extends ServiceName<S>>(desc: QueryDescriptor<S, N>, config: QueryConfig) {
    return new QueryRef<S, N>({ desc, config, queryStore: this.queryStore })
  }

  mutate<N extends ServiceName<S>>({
    serviceName,
    method,
    args,
  }: {
    serviceName: N
    method: string
    args: any[]
  }) {
    return this.queryStore.mutate({ serviceName, method, args })
  }

  subscribeToStateChanges(fn: (state: Map<string, Service<any>>) => void) {
    return this.queryStore.subscribeToStateChanges(fn)
  }
}

export function splitConfig<S extends Schema<any>, N extends ServiceName<S>>(
  combinedConfig: any,
): { desc: QueryDescriptor<S, N>; config: QueryConfig } {
  const {
    serviceName,
    method,
    resourceId,
    allPages,
    skip,
    realtime = 'merge',
    fetchPolicy = 'swr',
    matcher,
    ...params
  } = combinedConfig

  const desc = {
    serviceName,
    method,
    resourceId,
    params,
  } as QueryDescriptor<S, N>

  let config = {
    skip,
    realtime,
    fetchPolicy,
    allPages,
    matcher,
  }

  return { desc, config }
}

class QueryRef<S extends Schema<any>, N extends ServiceName<S>, T = ServiceType<S, N>> {
  #queryId: string
  #desc: QueryDescriptor<S, N>
  #config: QueryConfig
  #queryStore: QueryStore<S>

  constructor({
    desc,
    config,
    queryStore,
  }: {
    desc: QueryDescriptor<S, N>
    config: QueryConfig
    queryStore: QueryStore<S>
  }) {
    this.#queryId = `q/${hashObject({ desc, config })}`
    this.#desc = desc
    this.#config = config
    this.#queryStore = queryStore
  }

  details() {
    return {
      queryId: this.#queryId,
      desc: this.#desc,
      config: this.#config,
    }
  }

  hash() {
    return this.#queryId
  }

  subscribe(fn: (state: QueryState<T>) => void) {
    this.#queryStore.materialize(this)
    return this.#queryStore.subscribe(this.#queryId, fn)
  }

  getSnapshot(): QueryState<T> {
    this.#queryStore.materialize(this)
    return this.#queryStore.getQueryState<N, T>(this.#queryId)!
  }

  refetch() {
    this.#queryStore.materialize(this)
    return this.#queryStore.refetch(this.#queryId)
  }
}

class QueryStore<S extends Schema<any>> {
  #adapter: AdapterInterface<S>

  #realtime = new Set<string>()
  #listeners = new Map<string, Set<(state: QueryState<any>) => void>>()
  #globalListeners = new Set<(state: Map<string, Service<any>>) => void>()

  #state = new Map<string, Service<any>>()
  #serviceNamesByQueryId = new Map<string, ServiceName<S>>()

  constructor({ adapter }: { adapter: AdapterInterface<S> }) {
    this.#adapter = adapter
  }

  #getQuery<N extends ServiceName<S>, T = ServiceType<S, N>>(
    queryId: string,
  ): Query<S, N, T> | undefined {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    if (serviceName) {
      const service = this.getServiceState(serviceName)
      if (service) {
        return service.queries.get(queryId)
      }
    }
    return undefined
  }

  getQueryState<N extends ServiceName<S>, T = ServiceType<S, N>>(
    queryId: string,
  ): QueryState<T> | undefined {
    return this.#getQuery<N, T>(queryId)?.state
  }

  materialize<N extends ServiceName<S>>(queryRef: QueryRef<S, N>) {
    const { queryId, desc, config } = queryRef.details()

    if (!this.#getQuery(queryId)) {
      this.#serviceNamesByQueryId.set(queryId, desc.serviceName)

      this.#transactOverService(
        queryId,
        (service: Service<any>) => {
          service.queries.set(queryId, {
            queryId,
            desc,
            config,
            pending: true,
            filterItem: this.#createItemFilter(desc, config),
            state: config.skip
              ? {
                  data: null,
                  status: 'idle',
                  isFetching: false,
                  error: null,
                }
              : {
                  data: null,
                  status: 'loading',
                  isFetching: true,
                  error: null,
                },
          } as Query<S, N>)
        },
        { silent: true },
      )
    }
  }

  #createItemFilter<N extends ServiceName<S>>(desc: QueryDescriptor<S, N>, config: QueryConfig) {
    const filterItem = this.#adapter.matcher(desc.params?.query)
    return config.matcher ? config.matcher(desc.params?.query, filterItem) : filterItem
  }

  #addListener(queryId: string, fn: (state: QueryState<any>) => void) {
    if (!this.#listeners.has(queryId)) {
      this.#listeners.set(queryId, new Set())
    }
    this.#listeners.get(queryId)!.add(fn)
    return () => {
      const listeners = this.#listeners.get(queryId)
      if (listeners) {
        listeners.delete(fn)
        if (listeners.size === 0) {
          this.#listeners.delete(queryId)
        }
      }
    }
  }

  #invokeListeners(queryId: string) {
    const listeners = this.#listeners.get(queryId)
    if (listeners) {
      const state = this.getQueryState(queryId)
      listeners.forEach(listener => listener(state!))
    }
  }

  #addGlobalListener(fn: (state: Map<string, Service<any>>) => void) {
    this.#globalListeners.add(fn)
    return () => {
      this.#globalListeners.delete(fn)
    }
  }

  #invokeGlobalListeners() {
    const state = this.getState()
    this.#globalListeners.forEach(listener => listener(state))
  }

  #listenerCount(queryId: string) {
    return this.#listeners.get(queryId)?.size || 0
  }

  subscribe<N extends ServiceName<S>, T = ServiceType<S, N>>(
    queryId: string,
    fn: (state: QueryState<T>) => void,
  ) {
    const q = this.#getQuery(queryId)!
    if (
      q.pending ||
      (q.state.status === 'success' && q.config.fetchPolicy === 'swr' && !q.state.isFetching) ||
      (q.state.status === 'error' && !q.state.isFetching)
    ) {
      this.#queue(queryId)
    }

    const removeListener = this.#addListener(queryId, fn as (state: QueryState<any>) => void)

    this.#subscribeToRealtime(queryId)

    const shouldVacuumByDefault = q.config.fetchPolicy === 'network-only'
    return ({ vacuum = shouldVacuumByDefault } = {}) => {
      removeListener()
      if (vacuum && this.#listenerCount(queryId) === 0) {
        this.#vacuum({ queryId })
      }
    }
  }

  subscribeToStateChanges(fn: (state: Map<string, Service<any>>) => void) {
    return this.#addGlobalListener(fn)
  }

  refetch(queryId: string) {
    const q = this.#getQuery(queryId)
    if (q && !q.state.isFetching) {
      this.#queue(queryId)
    }
  }

  async #queue(queryId: string) {
    this.#fetching({ queryId })
    try {
      const result = await this.#fetch(queryId)
      this.#fetched({ queryId, result })
    } catch (err) {
      this.#fetchFailed({ queryId, error: err })
    }
  }

  #fetch(queryId: string) {
    const query = this.#getQuery(queryId)!
    const { serviceName, method, resourceId, params } = query.desc
    const { allPages } = query.config

    if (method === 'get') {
      return this.#adapter.get(serviceName, resourceId!, params)
    } else if (allPages) {
      return this.#adapter.findAll(serviceName, params)
    } else {
      return this.#adapter.find(serviceName, params)
    }
  }

  async mutate({
    serviceName,
    method,
    args,
  }: {
    serviceName: ServiceName<S>
    method: string
    args: any[]
  }) {
    const updaters = {
      create: (item: any) => this.#created({ serviceName, item }),
      update: (item: any) => this.#updated({ serviceName, item }),
      patch: (item: any) => this.#patched({ serviceName, item }),
      remove: (item: any) => this.#removed({ serviceName, item }),
    }

    const item = await this.#adapter.mutate(serviceName, method, args)
    updaters[method as keyof typeof updaters](item)
    return item
  }

  #subscribeToRealtime(queryId: string) {
    const query = this.#getQuery(queryId)!
    const { serviceName } = query.desc
    if (this.#realtime.has(serviceName)) {
      return
    }
    const created = (item: any) => {
      this.#created({ serviceName, item })
      this.#refetchRefetchableQueries(serviceName)
    }
    const updated = (item: any) => {
      this.#updated({ serviceName, item })
      this.#refetchRefetchableQueries(serviceName)
    }
    const patched = (item: any) => {
      this.#patched({ serviceName, item })
      this.#refetchRefetchableQueries(serviceName)
    }
    const removed = (item: any) => {
      this.#removed({ serviceName, item })
      this.#refetchRefetchableQueries(serviceName)
    }

    const unsub = this.#adapter.subscribe(serviceName, {
      created,
      updated,
      patched,
      removed,
    })
    this.#realtime.add(serviceName)
    return () => {
      unsub()
      this.#realtime.delete(serviceName)
    }
  }

  #refetchRefetchableQueries(serviceName: ServiceName<S>) {
    const service = this.getServiceState(serviceName)
    for (const query of service.queries.values()) {
      if (query.config.realtime === 'refetch') {
        this.refetch(query.queryId)
      }
    }
  }

  getState() {
    return this.#state
  }

  getServiceState(serviceName: ServiceName<S>) {
    const state = this.getState()
    if (!state.has(serviceName)) {
      state.set(serviceName, {
        entities: new Map(),
        queries: new Map(),
        itemQueryIndex: new Map(),
      })
    }
    return state.get(serviceName)!
  }

  #transactOverService(
    queryId: string,
    fn: (
      service: Service<any>,
      query: Query<S, ServiceName<S>, any>,
      touch: (queryId: string) => void,
    ) => void,
    options?: { silent: boolean },
  ) {
    const serviceName = this.#serviceNamesByQueryId.get(queryId)
    this.#transactOverServiceByName(
      serviceName!,
      (service: Service<any>, touch: (queryId: string) => void) => {
        fn(service, service.queries.get(queryId)!, touch)
        touch(queryId)
      },
      options || { silent: false },
    )
  }

  #transactOverServiceByName(
    serviceName: ServiceName<S>,
    mutate: (service: Service<any>, touch: (queryId: string) => void) => void,
    { silent = false } = {},
  ) {
    if (serviceName) {
      const modifiedQueries = new Set<string>()

      const touch = (queryId: string) => modifiedQueries.add(queryId)

      mutate(this.getServiceState(serviceName), touch)

      if (!silent && modifiedQueries.size > 0) {
        for (const queryId of modifiedQueries) {
          this.#invokeListeners(queryId)
        }
        this.#invokeGlobalListeners()
      }
    }
  }

  #fetching({ queryId }: { queryId: string }) {
    this.#transactOverService(
      queryId,
      (service: Service<any>, query: Query<S, ServiceName<S>, any>) => {
        service.queries.set(queryId, {
          ...query,
          pending: false,
          state:
            query.state.status === 'error'
              ? { ...query.state, isFetching: true, status: 'loading', error: null }
              : { ...query.state, isFetching: true },
        })
      },
    )
  }

  #fetched({ queryId, result }: { queryId: string; result: { data: any | any[]; meta?: any } }) {
    this.#transactOverService(
      queryId,
      (service: Service<any>, query: Query<S, ServiceName<S>, any>) => {
        const { data, meta } = result
        const items = Array.isArray(data) ? data : [data]

        for (const item of items) {
          const itemId = this.#adapter.getId(item)
          service.entities.set(itemId, item)
          if (!service.itemQueryIndex.has(itemId)) {
            service.itemQueryIndex.set(itemId, new Set())
          }
          service.itemQueryIndex.get(itemId)!.add(queryId)
        }

        service.queries.set(queryId, {
          ...query,
          state: {
            data,
            meta,
            status: 'success',
            isFetching: false,
            error: null,
          },
        })
      },
    )
  }

  #fetchFailed({ queryId, error }: { queryId: string; error: any }) {
    this.#transactOverService(
      queryId,
      (service: Service<any>, query: Query<S, ServiceName<S>, any>) => {
        service.queries.set(queryId, {
          ...query,
          state: {
            data: null,
            status: 'error',
            isFetching: false,
            error,
          },
        })
      },
    )
  }

  #created({ serviceName, item: itemOrItems }: { serviceName: ServiceName<S>; item: any | any[] }) {
    const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems]

    for (const item of items) {
      const itemId = this.#adapter.getId(item)
      const service = this.getServiceState(serviceName)
      service.entities.set(itemId, item)
    }

    return this.#updateQueries({ serviceName, method: 'create', item: itemOrItems })
  }

  #updated({ serviceName, item }: { serviceName: ServiceName<S>; item: any }) {
    const itemId = this.#adapter.getId(item)

    const currItem = this.getServiceState(serviceName).entities.get(itemId)

    if (currItem && this.#adapter.isItemStale(currItem, item)) {
      return
    }

    const service = this.getServiceState(serviceName)
    service.entities.set(itemId, item)

    this.#updateQueries({ serviceName, method: 'update', item })
  }

  #patched(payload: any) {
    return this.#updated(payload)
  }

  #removed({ serviceName, item: itemOrItems }: { serviceName: ServiceName<S>; item: any | any[] }) {
    const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems]

    const service = this.getServiceState(serviceName)
    for (const item of items) {
      const itemId = this.#adapter.getId(item)
      service.entities.delete(itemId)
    }

    this.#updateQueries({ serviceName, method: 'remove', item: itemOrItems })
  }

  #updateQueries({
    serviceName,
    method,
    item: itemOrItems,
  }: {
    serviceName: ServiceName<S>
    method: string
    item: any | any[]
  }) {
    const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems]

    this.#transactOverServiceByName(
      serviceName,
      (service: Service<any>, touch: (queryId: string) => void) => {
        for (const item of items) {
          const itemId = this.#adapter.getId(item)

          if (!service.itemQueryIndex.has(itemId)) {
            service.itemQueryIndex.set(itemId, new Set())
          }
          const itemQueryIndex = service.itemQueryIndex.get(itemId)!

          for (const [queryId, query] of service.queries) {
            let matches

            if (query.config.realtime !== 'merge') {
              continue
            }

            if (method === 'find' && query.config.fetchPolicy === 'network-only') {
              continue
            }

            if (method === 'remove') {
              matches = false
            } else {
              matches = query.filterItem(item)
            }

            const hasItem = itemQueryIndex.has(queryId)
            if (hasItem && !matches) {
              // remove
              const query = service.queries.get(queryId)!
              service.queries.set(queryId, {
                ...query,
                state: {
                  ...query.state,
                  meta: this.#adapter.itemRemoved(query.state.meta),
                  data:
                    query.desc.method === 'get'
                      ? null
                      : (query.state.data as any[]).filter(x => this.#adapter.getId(x) !== itemId),
                },
              })
              itemQueryIndex.delete(queryId)
              touch(queryId)
            } else if (hasItem && matches) {
              // update
              service.queries.set(queryId, {
                ...query,
                state: {
                  ...query.state,
                  data:
                    query.desc.method === 'get'
                      ? item
                      : (query.state.data as any[]).map(x =>
                          this.#adapter.getId(x) === itemId ? item : x,
                        ),
                },
              })
              touch(queryId)
            } else if (matches && query.desc.method === 'find' && query.state.data) {
              service.queries.set(queryId, {
                ...query,
                state: {
                  ...query.state,
                  meta: this.#adapter.itemAdded(query.state.meta),
                  data: (query.state.data as any[]).concat(item),
                },
              })
              itemQueryIndex.add(queryId)
              touch(queryId)
            }
          }
        }
      },
    )
  }

  #vacuum({ queryId }: { queryId: string }) {
    this.#transactOverService(
      queryId,
      (service: Service<any>, query: Query<S, ServiceName<S>, any>) => {
        if (query) {
          if (query.state.data) {
            const items = Array.isArray(query.state.data) ? query.state.data : [query.state.data]
            for (const item of items) {
              const id = this.#adapter.getId(item)
              if (service.itemQueryIndex.has(id)) {
                service.itemQueryIndex.get(id)!.delete(queryId)
              }
            }
          }
          service.queries.delete(queryId)
          this.#serviceNamesByQueryId.delete(queryId)
        }
      },
      { silent: true },
    )
  }
}
