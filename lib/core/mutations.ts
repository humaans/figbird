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

/**
 * Per-call mutation options — call-specific data only; the write *policy*
 * (optimistic vs confirmed) lives on the handle variant, not per call.
 */
export interface MutationCallOptions<TItem = unknown> {
  /** Adapter params passthrough (e.g. Feathers `{ query }`). */
  params?: unknown
  /**
   * Explicit synthesized item to show optimistically — for computed fields the
   * request payload doesn't carry (`{ ...item, computedField }`). Ignored on
   * `confirmed` handles, which never show unconfirmed state.
   */
  optimisticItem?: TItem
}

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
 * The schema's method map is intersected with a generic `Record<string, fn>`
 * (see `DeriveMethods`), whose index signature would swallow the declared names
 * in a mapped type. This homomorphic remap drops the index signature and keeps
 * only the explicitly declared method names.
 */
type DeclaredKeys<T> = keyof {
  [K in keyof T as string extends K ? never : K]: 0
} &
  string

/**
 * Custom schema methods exposed directly on the handle, typed from the schema.
 * Only declared method names exist here (undeclared ones go through `call()`),
 * and reserved names always mean the built-in: same-named custom methods are
 * excluded and shadowed at runtime.
 */
type CustomMethods<S extends Schema, N extends ServiceNames<S>> = {
  [M in Exclude<DeclaredKeys<ServiceMethods<S, N>>, ReservedHandleKeys>]: (
    ...args: MethodArgs<ServiceMethods<S, N>[M]>
  ) => Promise<MethodData<ServiceMethods<S, N>[M]>>
}

interface HandleVerbs<S extends Schema, N extends ServiceNames<S>> {
  create(
    data: ServiceCreate<S, N>,
    options?: MutationCallOptions<ServiceItem<S, N>>,
  ): Promise<ServiceItem<S, N>>
  create(
    data: ServiceCreate<S, N>[],
    options?: MutationCallOptions<ServiceItem<S, N>[]>,
  ): Promise<ServiceItem<S, N>[]>
  update(
    id: string | number,
    data: ServiceUpdate<S, N>,
    options?: MutationCallOptions<ServiceItem<S, N>>,
  ): Promise<ServiceItem<S, N>>
  patch(
    id: string | number,
    data: ServicePatch<S, N>,
    options?: MutationCallOptions<ServiceItem<S, N>>,
  ): Promise<ServiceItem<S, N>>
  remove(
    id: string | number,
    options?: MutationCallOptions<ServiceItem<S, N>>,
  ): Promise<ServiceItem<S, N>>
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
export type MutationsHandle<S extends Schema, N extends ServiceNames<S>> = HandleVerbs<S, N> &
  CustomMethods<S, N> & {
    /** Variant that waits for the server ack before the cache shows the change. */
    readonly confirmed: HandleVerbs<S, N> & CustomMethods<S, N>
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

interface HandleConfig {
  /** false → confirmed variant: the cache updates only after the server acks. */
  optimistic: boolean
}

function createHandle(host: MutationsHost, serviceName: string, config: HandleConfig): object {
  const { optimistic } = config

  const resolveOptimistic = (options?: MutationCallOptions) =>
    optimistic ? (options?.optimisticItem ?? true) : false

  const base: Record<string, unknown> = {
    create: (data: unknown, options?: MutationCallOptions) =>
      host.mutate({
        serviceName,
        method: 'create',
        data,
        ...(options?.params !== undefined ? { params: options.params } : {}),
        optimistic: resolveOptimistic(options),
      } as MutationDescriptor),
    update: (id: string | number, data: unknown, options?: MutationCallOptions) =>
      host.mutate({
        serviceName,
        method: 'update',
        id,
        data,
        ...(options?.params !== undefined ? { params: options.params } : {}),
        optimistic: resolveOptimistic(options),
      } as MutationDescriptor),
    patch: (id: string | number, data: unknown, options?: MutationCallOptions) =>
      host.mutate({
        serviceName,
        method: 'patch',
        id,
        data,
        ...(options?.params !== undefined ? { params: options.params } : {}),
        optimistic: resolveOptimistic(options),
      } as MutationDescriptor),
    remove: (id: string | number, options?: MutationCallOptions) =>
      host.mutate({
        serviceName,
        method: 'remove',
        id,
        ...(options?.params !== undefined ? { params: options.params } : {}),
        // remove has no payload to synthesize — optimistic is boolean-only here
        optimistic,
      } as MutationDescriptor),
    call: (method: string, ...args: unknown[]) => host.call(serviceName, method, args),
  }

  if (optimistic) {
    // Interned lazily so `m.issues.confirmed` is referentially stable.
    let confirmedVariant: object | null = null
    Object.defineProperty(base, 'confirmed', {
      enumerable: false,
      get: () => (confirmedVariant ??= createHandle(host, serviceName, { optimistic: false })),
    })
  }

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
}

/**
 * Build the untyped runtime `m` proxy: services as properties, handles interned
 * per service. Custom methods are phantom types — they do not exist at runtime —
 * so each handle is itself a Proxy: any property that is not a reserved key or a
 * known protocol prop becomes a call to that custom method. @internal
 */
export function createMutationsProxy(host: MutationsHost): object {
  const handles = new Map<string, object>()
  const handleFor = (serviceName: string): object => {
    let handle = handles.get(serviceName)
    if (!handle) {
      handle = createHandle(host, serviceName, { optimistic: true })
      handles.set(serviceName, handle)
    }
    return handle
  }

  // No protocol guards needed at this level: every string property resolves to a
  // handle OBJECT (not a function) — including function-target props like `call`
  // or `name` — so probes like `then` or `toJSON` are never callable here and
  // `await m` / JSON.stringify(m) behave inertly.
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
