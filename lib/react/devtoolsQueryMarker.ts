type QuerySubscription = (...args: never[]) => unknown

const queryKeysBySubscription = new WeakMap<QuerySubscription, readonly string[]>()

/** Associates a React external-store subscription with the query roots it owns. @internal */
export function markQuerySubscription(
  subscription: QuerySubscription,
  queryKeys: readonly string[],
): void {
  queryKeysBySubscription.set(subscription, queryKeys)
}

/** Reads an association without exposing it on the function or the public API. @internal */
export function queryKeysForSubscription(value: unknown): readonly string[] | undefined {
  if (typeof value !== 'function') return undefined
  return queryKeysBySubscription.get(value as QuerySubscription)
}
