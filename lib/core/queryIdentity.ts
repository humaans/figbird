import { hashObject } from './hash.js'
import type { QueryConfig, QueryDescriptor } from './queryTypes.js'

export const queryIdentityKey: unique symbol = Symbol('figbird.queryIdentity')

export type QueryIdentityConfig = {
  [queryIdentityKey]?: string
}

let nextIsolatedQueryIdentity = 0

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
