import { hashObject } from './hash.js'
import type { MethodArgs, MethodData } from './mutations.js'
import type { Schema, ServiceQueries, ServiceNames } from './schema.js'

declare const customQueryResult: unique symbol

/** An inert custom query. Arguments are forwarded unchanged when the query executes. */
export class CustomQuery<S extends Schema, TResult> {
  // Carries the result type without adding a runtime field.
  declare readonly [customQueryResult]: TResult
  readonly #key: string

  constructor(
    readonly schema: S,
    readonly serviceName: string,
    readonly method: string,
    readonly args: unknown[],
  ) {
    this.#key = `cq/${hashObject({ serviceName, method, args: argumentKey(args) })}`
  }

  hash(): string {
    return this.#key
  }
}

export type CustomQueryMethods<S extends Schema, N extends ServiceNames<S>> = {
  readonly [M in keyof ServiceQueries<S, N> & string]: (
    ...args: MethodArgs<ServiceQueries<S, N>[M]>
  ) => CustomQuery<S, MethodData<ServiceQueries<S, N>[M]>>
}

/** Tagged values distinguish omitted/undefined arguments from null without changing transport arguments. */
function argumentKey(value: unknown, ancestors = new Set<object>(), orderedKeys = false): unknown {
  if (value === undefined) return ['undefined']
  if (value === null) return ['null']
  if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value]
  if (typeof value === 'number' && Number.isFinite(value))
    return ['number', Object.is(value, -0) ? '-0' : String(value)]
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return ['date', value.toISOString()]
  if (typeof value !== 'object' || ancestors.has(value))
    throw new TypeError('Custom query arguments must be acyclic plain data, undefined, or Dates')
  ancestors.add(value)
  try {
    if (Array.isArray(value))
      return ['array', Array.from(value, item => argumentKey(item, ancestors))]
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new TypeError('Custom query arguments must be plain data')
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw new TypeError('Custom query arguments cannot have symbol keys')
    const keys = Object.keys(value)
    if (!orderedKeys) keys.sort()
    return [
      'object',
      keys.map(key => [key, argumentKey(Reflect.get(value, key), ancestors, key === '$sort')]),
    ]
  } finally {
    ancestors.delete(value)
  }
}
