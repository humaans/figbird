interface AbandonedRead {
  readonly coldReadGroup?: object
  canEvictAbandonedRead(): boolean
  evictAbandonedRead(): boolean
}

/** Parallel Suspense reads retain and evict together so large reads can commit. */
export function trimAbandonedReads<T extends AbandonedRead>(
  cache: ReadonlyMap<string, T>,
  protectedRef: T | undefined,
): void {
  if (cache.size <= 20) return
  const groups = new Map<object, T[]>()
  for (const ref of cache.values()) {
    const key = ref.coldReadGroup ?? ref
    const group = groups.get(key) ?? []
    group.push(ref)
    // The most recently accessed member determines the group's recency.
    groups.delete(key)
    groups.set(key, group)
  }
  let retained = groups.size
  for (const group of groups.values()) {
    if (retained <= 20) return
    if (group.some(ref => ref === protectedRef || !ref.canEvictAbandonedRead())) continue
    for (const ref of group) ref.evictAbandonedRead()
    retained--
  }
}
