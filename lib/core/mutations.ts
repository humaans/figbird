/**
 * The write-side DSL: `m.<service>.<verb>(...)`.
 *
 * `m` is the write counterpart of the `q` builder proxy — services are
 * properties, verbs are methods. Handles are stateless plain values (no hook,
 * no lifecycle): callable at module scope, in event handlers, in non-React
 * code. CRUD calls route through the store (cache updates, optimistic
 * handling, rollback); custom schema methods route through `queryStore.call`
 * (no cache update, but tracked and observable like any mutation).
 *
 * Writes are optimistic by default — the cache shows the change immediately
 * and rolls it back on failure. Surfaces that must not show a change until the
 * server confirms it opt out via the `confirmed` variant:
 *
 * ```ts
 * m.issues.patch(id, { status: 'closed' })      // optimistic (default)
 * m.policies.confirmed.create(policy)           // waits for the server ack
 * ```
 *
 * Pending/error UI state deliberately lives elsewhere: per-action state in
 * `useAction` (one hook call site per action), per-entity/service activity in
 * `useMutating`.
 */

import type { MutationDescriptor } from './queryTypes.js'
import type {
  Schema,
  ServiceCreate,
  ServiceItem,
  ServiceMethods,
  ServiceNames,
  ServicePatch,
  ServiceUpdate,
} from './schema.js'

type OptimisticWriteProjection<TItem> =
  | {
      /** Explicit complete item to show optimistically. */
      optimisticItem: TItem
      optimisticPatch?: never
    }
  | {
      optimisticItem?: never
      /** Partial record to merge into the current optimistic projection. */
      optimisticPatch: Partial<TItem>
    }
  | {
      optimisticItem?: never
      optimisticPatch?: never
    }

/** Adapter params shared by every mutation method and policy variant. */
export interface MutationParamsOptions {
  /** Adapter params passthrough (e.g. Feathers `{ query }`). */
  params?: unknown
}

/** Projection options for an optimistic create. */
export type CreateMutationOptions<TItem> = MutationParamsOptions & {
  /** Explicit complete item to show optimistically. */
  optimisticItem?: TItem
}

/** Projection options for an optimistic update or patch. */
export type WriteMutationOptions<TItem> = MutationParamsOptions & OptimisticWriteProjection<TItem>

/** @deprecated Use the mutation-specific option type instead. */
export type MutationCallOptions<TItem = unknown> = WriteMutationOptions<TItem>

export type MethodArgs<TMethod> = TMethod extends (
  ...args: infer TArgs extends unknown[]
) => unknown
  ? TArgs
  : never

export type MethodData<TMethod> = TMethod extends (
  ...args: infer TArgs extends unknown[]
) => infer TResult
  ? TArgs extends unknown[]
    ? Awaited<TResult>
    : never
  : never

/** Reserved handle keys — a schema method with one of these names is shadowed. */
type ReservedHandleKeys = 'create' | 'update' | 'patch' | 'remove' | 'call' | 'confirmed'

/**
 * Custom schema methods exposed directly on the handle, typed from the schema.
 * Only declared method names exist here (undeclared ones go through `call()`),
 * and reserved names always mean the built-in: same-named custom methods are
 * excluded and shadowed at runtime.
 */
type CustomMethods<S extends Schema, N extends ServiceNames<S>> = {
  [M in Exclude<keyof ServiceMethods<S, N> & string, ReservedHandleKeys>]: (
    ...args: MethodArgs<ServiceMethods<S, N>[M]>
  ) => Promise<MethodData<ServiceMethods<S, N>[M]>>
}

export type CreateOptionsFor<TItem, TOptimistic extends boolean> = TOptimistic extends true
  ? CreateMutationOptions<TItem>
  : MutationParamsOptions

export type WriteOptionsFor<TItem, TOptimistic extends boolean> = TOptimistic extends true
  ? WriteMutationOptions<TItem>
  : MutationParamsOptions

interface HandleVerbs<S extends Schema, N extends ServiceNames<S>, TOptimistic extends boolean> {
  create(
    data: ServiceCreate<S, N>,
    options?: CreateOptionsFor<ServiceItem<S, N>, TOptimistic>,
  ): Promise<ServiceItem<S, N>>
  create(
    data: ServiceCreate<S, N>[],
    options?: CreateOptionsFor<ServiceItem<S, N>[], TOptimistic>,
  ): Promise<ServiceItem<S, N>[]>
  update(
    id: string | number,
    data: ServiceUpdate<S, N>,
    options?: WriteOptionsFor<ServiceItem<S, N>, TOptimistic>,
  ): Promise<ServiceItem<S, N>>
  patch(
    id: string | number,
    data: ServicePatch<S, N>,
    options?: WriteOptionsFor<ServiceItem<S, N>, TOptimistic>,
  ): Promise<ServiceItem<S, N>>
  remove(id: string | number, options?: MutationParamsOptions): Promise<ServiceItem<S, N>>
  /**
   * Call a custom service method by name — the escape hatch for methods not
   * declared in the schema (declared ones appear directly on the handle, typed).
   */
  call(method: string, ...args: unknown[]): Promise<unknown>
}

/**
 * The write handle for one service: CRUD + typed custom methods. Optimistic by
 * default; `confirmed` is the same handle with "show it only once it's real"
 * semantics (the cache updates after the server acks).
 */
export type MutationsHandle<S extends Schema, N extends ServiceNames<S>> = HandleVerbs<S, N, true> &
  CustomMethods<S, N> & {
    /** Variant that waits for the server ack before the cache shows the change. */
    readonly confirmed: HandleVerbs<S, N, false> & CustomMethods<S, N>
  }

/**
 * The write proxy: services as properties, mirroring `q`.
 * `m.issues.patch(...)`, `m.policies.confirmed.create(...)`.
 * Also callable for dynamic service names — `m(serviceName)` is `m.<name>`
 * with a string-typed door, mirroring `q(serviceName)`.
 */
export type MutationsProxy<S extends Schema> = {
  <N extends ServiceNames<S>>(serviceName: N): MutationsHandle<S, N>
  (serviceName: string): MutationsHandle<S, ServiceNames<S>>
} & {
  readonly [N in ServiceNames<S>]: MutationsHandle<S, N>
}

/**
 * The slice of a Figbird instance a handle needs. Service-path resolution is the
 * host's job — the handle passes schema keys through untouched. @internal
 */
export interface MutationsHost {
  mutate(desc: MutationDescriptor): Promise<unknown>
  call(serviceName: string, method: string, args: unknown[]): Promise<unknown>
}

export interface CrudHandleConfig {
  /** false → confirmed variant: the cache updates only after the server acks. */
  optimistic: boolean
}

type RuntimeMutationOptions = MutationParamsOptions & {
  optimisticItem?: unknown
  optimisticPatch?: unknown
}

type CrudHandleDecorator = (base: Record<string, unknown>) => object

/**
 * Build the canonical CRUD descriptor surface shared by ordinary mutations and
 * transaction collectors. A decorator may add custom-method behavior without
 * duplicating descriptor construction or confirmed-handle policy. @internal
 */
export function createCrudHandle(
  dispatch: (desc: MutationDescriptor) => unknown,
  serviceName: string,
  config: CrudHandleConfig,
  decorate: CrudHandleDecorator = base => base,
): object {
  const { optimistic } = config

  const resolveOptimistic = (options?: RuntimeMutationOptions) =>
    optimistic ? (options?.optimisticItem ?? true) : false

  const base: Record<string, unknown> = {
    create: (data: unknown, options?: RuntimeMutationOptions) =>
      dispatch({
        serviceName,
        method: 'create',
        data,
        ...(options?.params !== undefined ? { params: options.params } : {}),
        optimistic: resolveOptimistic(options),
      }),
    update: (id: string | number, data: unknown, options?: RuntimeMutationOptions) =>
      dispatch({
        serviceName,
        method: 'update',
        id,
        data,
        ...(options?.params !== undefined ? { params: options.params } : {}),
        optimistic: resolveOptimistic(options),
        ...(options?.optimisticPatch !== undefined
          ? { optimisticPatch: options.optimisticPatch }
          : {}),
      }),
    patch: (id: string | number, data: unknown, options?: RuntimeMutationOptions) =>
      dispatch({
        serviceName,
        method: 'patch',
        id,
        data,
        ...(options?.params !== undefined ? { params: options.params } : {}),
        optimistic: resolveOptimistic(options),
        ...(options?.optimisticPatch !== undefined
          ? { optimisticPatch: options.optimisticPatch }
          : {}),
      }),
    remove: (id: string | number, options?: RuntimeMutationOptions) =>
      dispatch({
        serviceName,
        method: 'remove',
        id,
        ...(options?.params !== undefined ? { params: options.params } : {}),
        // remove has no payload to synthesize — optimistic is boolean-only here
        optimistic,
      }),
  }

  if (optimistic) {
    // Interned lazily so `m.issues.confirmed` is referentially stable.
    let confirmedVariant: object | null = null
    Object.defineProperty(base, 'confirmed', {
      enumerable: false,
      get: () =>
        (confirmedVariant ??= createCrudHandle(
          dispatch,
          serviceName,
          { optimistic: false },
          decorate,
        )),
    })
  }

  return decorate(base)
}

function createHandle(host: MutationsHost, serviceName: string, config: CrudHandleConfig): object {
  return createCrudHandle(
    desc => host.mutate(desc),
    serviceName,
    config,
    base => {
      base.call = (method: string, ...args: unknown[]) => host.call(serviceName, method, args)
      return new Proxy(base, {
        get(target, prop, receiver) {
          // `in` includes the prototype chain, so Object.prototype members resolve
          // normally instead of becoming calls.
          if (typeof prop === 'symbol' || prop in target) {
            return Reflect.get(target, prop, receiver)
          }
          // A callable `then` makes the handle thenable: returning one from an async
          // function would make the `await` invoke it and hang forever, unsettled.
          if (prop === 'then') return undefined
          // A callable `toJSON` would turn JSON.stringify(handle) — logging, error
          // reporting — into a phantom network write.
          if (prop === 'toJSON') return undefined
          return (...args: unknown[]) => host.call(serviceName, prop, args)
        },
      })
    },
  )
}

/** Build a callable, property-addressable proxy with interned service handles. @internal */
export function createServiceHandleProxy(createHandle: (serviceName: string) => object): object {
  const handles = new Map<string, object>()
  const handleFor = (serviceName: string): object => {
    let handle = handles.get(serviceName)
    if (!handle) {
      handle = createHandle(serviceName)
      handles.set(serviceName, handle)
    }
    return handle
  }

  const callable = (serviceName: string) => handleFor(serviceName)
  return new Proxy(callable as object, {
    apply(_target, _thisArg, [serviceName]: [string]) {
      return handleFor(serviceName)
    },
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined
      return handleFor(prop)
    },
  })
}

/**
 * Build the untyped runtime `m` proxy: services as properties, handles interned
 * per service. Custom methods are phantom types — they do not exist at runtime —
 * so each handle is itself a Proxy: any property that is not a reserved key or a
 * known protocol prop becomes a call to that custom method. @internal
 */
export function createMutationsProxy(host: MutationsHost): object {
  // No protocol guards needed at this level: every string property resolves to a
  // handle OBJECT (not a function) — including function-target props like `call`
  // or `name` — so probes like `then` or `toJSON` are never callable here and
  // `await m` / JSON.stringify(m) behave inertly.
  return createServiceHandleProxy(serviceName =>
    createHandle(host, serviceName, { optimistic: true }),
  )
}
