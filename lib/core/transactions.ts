import type { MutationDescriptor } from './queryTypes.js'
import type {
  Schema,
  ServiceCreate,
  ServiceItem,
  ServiceNames,
  ServicePatch,
  ServiceUpdate,
} from './schema.js'
import type { CreateOptionsFor, MutationParamsOptions, WriteOptionsFor } from './mutations.js'
import { createCrudHandle, createServiceHandleProxy } from './mutations.js'

interface TransactionHandleVerbs<
  S extends Schema,
  N extends ServiceNames<S>,
  TOptimistic extends boolean,
> {
  create(
    data: ServiceCreate<S, N>,
    options?: CreateOptionsFor<ServiceItem<S, N>, TOptimistic>,
  ): void
  update(
    id: string | number,
    data: ServiceUpdate<S, N>,
    options?: WriteOptionsFor<ServiceItem<S, N>, TOptimistic>,
  ): void
  patch(
    id: string | number,
    data: ServicePatch<S, N>,
    options?: WriteOptionsFor<ServiceItem<S, N>, TOptimistic>,
  ): void
  remove(id: string | number, options?: MutationParamsOptions): void
}

/** Typed CRUD collector for one service inside a transaction. */
export type TransactionMutationsHandle<
  S extends Schema,
  N extends ServiceNames<S>,
> = TransactionHandleVerbs<S, N, true> & {
  /** Collect a mutation without projecting it before the transaction commits. */
  readonly confirmed: TransactionHandleVerbs<S, N, false>
}

/** The transaction-scoped counterpart of `figbird.m`. Calls collect work and return void. */
export type TransactionMutationsProxy<S extends Schema> = {
  <N extends ServiceNames<S>>(serviceName: N): TransactionMutationsHandle<S, N>
  (serviceName: string): TransactionMutationsHandle<S, ServiceNames<S>>
} & {
  readonly [N in ServiceNames<S>]: TransactionMutationsHandle<S, N>
}

/** Context passed to `figbird.transaction()`. */
export interface TransactionContext<S extends Schema> {
  readonly m: TransactionMutationsProxy<S>
}

/** Build a transaction-scoped collector and expose the descriptors after the callback. @internal */
export function createTransactionContext<S extends Schema>(): {
  context: TransactionContext<S>
  close(): readonly MutationDescriptor[]
} {
  const descriptors: MutationDescriptor[] = []
  let active = true

  const collect = (desc: MutationDescriptor): void => {
    if (!active) {
      throw new Error('figbird: transaction mutations can only be collected synchronously')
    }
    descriptors.push(desc)
  }
  const m = createServiceHandleProxy(serviceName =>
    createCrudHandle(collect, serviceName, { optimistic: true }),
  ) as TransactionMutationsProxy<S>

  return {
    context: { m },
    close: () => {
      active = false
      return descriptors
    },
  }
}
