import type { MethodArgs, MethodData } from './mutations.js'
import { createServiceHandleProxy } from './mutations.js'
import type { Schema, ServiceMethods, ServiceNames } from './schema.js'

/** Protocol probes and CRUD operations are not custom reads. */
type ReservedReadKeys =
  | 'then'
  | 'toJSON'
  | 'find'
  | 'get'
  | 'create'
  | 'update'
  | 'patch'
  | 'remove'

export type ReadsHandle<S extends Schema, N extends ServiceNames<S>> = {
  readonly [M in Exclude<keyof ServiceMethods<S, N> & string, ReservedReadKeys>]: (
    ...args: MethodArgs<ServiceMethods<S, N>[M]>
  ) => Promise<MethodData<ServiceMethods<S, N>[M]>>
}

/** Imperative custom reads: one invocation, one transport request, no cache. */
export type ReadsProxy<S extends Schema> = {
  <N extends ServiceNames<S>>(serviceName: N): ReadsHandle<S, N>
} & {
  readonly [N in ServiceNames<S>]: ReadsHandle<S, N>
}

const reservedReadKeys = new Set([
  'then',
  'toJSON',
  'find',
  'get',
  'create',
  'update',
  'patch',
  'remove',
])

/** @internal */
export function createReadsProxy(
  read: (serviceName: string, method: string, args: unknown[]) => Promise<unknown>,
): object {
  return createServiceHandleProxy(
    serviceName =>
      new Proxy(
        {},
        {
          get(target, prop, receiver) {
            if (typeof prop === 'symbol') return undefined
            if (reservedReadKeys.has(prop)) return undefined
            if (prop in target) return Reflect.get(target, prop, receiver)
            return (...args: unknown[]) => read(serviceName, prop, args)
          },
        },
      ),
  )
}
