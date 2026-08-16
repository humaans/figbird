import { hashObject } from './hash.js'
import type { QueryConfig, QueryDescriptor } from './queryTypes.js'

export const queryIdentityKey: unique symbol = Symbol('figbird.queryIdentity')

export type QueryIdentityConfig = {
  [queryIdentityKey]?: string
}

/** Internal cache-lifecycle controls that remain part of query identity. */
export interface QueryLifecycleConfig {
  gcOnUnsubscribe?: boolean
}

let nextIsolatedQueryIdentity = 0

/** Results that belong to one consumer and are removed with its last subscription. */
export function isEphemeralQuery<TItem, TQuery>(
  config: QueryConfig<TItem, TQuery> & QueryLifecycleConfig,
): boolean {
  return (
    config.gcOnUnsubscribe === true ||
    config.fetchPolicy === 'network-only' ||
    (config.matcher !== undefined && config.matcherKey === undefined)
  )
}

export function createQueryId<TItem, TQuery>(
  desc: QueryDescriptor,
  config: QueryConfig<TItem, TQuery>,
): string {
  return `q/${hashObject(getQueryIdentity(desc, config))}`
}

function getQueryIdentity<TItem, TQuery>(
  desc: QueryDescriptor,
  config: QueryConfig<TItem, TQuery>,
): unknown {
  const scope = getQueryIdentityScope(config)

  return {
    desc,
    config: getHashableConfig(config),
    ...(scope !== undefined && { scope }),
  }
}

function getQueryIdentityScope<TItem, TQuery>(
  config: QueryConfig<TItem, TQuery>,
): string | undefined {
  const internalScope = (config as QueryConfig<TItem, TQuery> & QueryIdentityConfig)[
    queryIdentityKey
  ]
  if (internalScope !== undefined) {
    return internalScope
  }

  if (config.matcher && config.matcherKey !== undefined) {
    return `matcher/${config.matcherKey}`
  }

  if (config.matcher) {
    return `matcher/${++nextIsolatedQueryIdentity}`
  }

  return undefined
}

function getHashableConfig<TItem, TQuery>(config: QueryConfig<TItem, TQuery>): unknown {
  if (!config.matcher) {
    return config
  }

  const hashableConfig: Record<PropertyKey, unknown> = { ...config }
  delete hashableConfig.matcher
  delete hashableConfig[queryIdentityKey]

  return {
    ...hashableConfig,
    matcher: 'custom',
  }
}
