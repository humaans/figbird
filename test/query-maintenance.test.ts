import test from 'ava'
import { compileQueryMaintenance, queryPolicy } from '../lib/core/queryMaintenance.js'
import type { QueryConfig, QueryDescriptor } from '../lib/core/queryTypes.js'
import { compareValues } from '../lib/core/sort.js'

// Preserve the rules that preceded the compiler as an independent equivalence oracle.
test('compiled policies preserve the original rules in all 1,024 combinations', t => {
  const methods = ['get', 'find'] as const
  const realtimeModes: QueryConfig['realtime'][] = [undefined, 'merge', 'refetch', 'disabled']
  const fetchPolicies: QueryConfig['fetchPolicy'][] = [
    undefined,
    'swr',
    'cache-first',
    'network-only',
  ]
  const queries: Record<string, unknown>[] = [
    {},
    { active: true },
    { $limit: 5 },
    { $skip: 5 },
    { $sort: { id: 1 } },
    { $select: ['id'] },
    { $unknown: true },
    { $or: [{ $select: ['id'] }] },
  ]
  let cases = 0
  for (const method of methods) {
    for (const realtime of realtimeModes) {
      for (const fetchPolicy of fetchPolicies) {
        for (const server of [false, true]) {
          for (const allPages of [false, true]) {
            for (const query of queries) {
              const config: QueryConfig = {
                ...(realtime === undefined ? {} : { realtime }),
                ...(fetchPolicy === undefined ? {} : { fetchPolicy }),
                server,
                allPages,
              }
              const desc: QueryDescriptor =
                method === 'get'
                  ? { method, serviceName: 'notes', resourceId: 1, params: { query } }
                  : { method, serviceName: 'notes', params: { query } }
              const maintenance = compileQueryMaintenance({
                desc,
                config,
                defaultSort: undefined,
                compare: compareValues,
                localOperators: new Set(),
                matcher: () => () => true,
              })
              const { classification, isProjection } = maintenance
              const serverMaintained =
                classification === 'server-window' || classification === 'server-authoritative'
              const fetchOwned =
                realtime === 'refetch' ||
                ((realtime === undefined || realtime === 'merge') &&
                  classification === 'server-authoritative')
              const responseMode =
                realtime === 'disabled'
                  ? 'snapshot'
                  : isProjection
                    ? 'projection'
                    : fetchOwned
                      ? 'fetch-owned'
                      : 'entity'
              const ownsValues =
                realtime === 'disabled' ||
                fetchOwned ||
                fetchPolicy === 'network-only' ||
                isProjection
              const label = JSON.stringify({
                method,
                realtime,
                fetchPolicy,
                server,
                allPages,
                query,
              })
              t.deepEqual(
                queryPolicy(maintenance),
                {
                  responseMode,
                  rowSource: ownsValues ? 'values' : 'entities',
                  mergeEvents:
                    realtime === 'merge' && !(method === 'find' && fetchPolicy === 'network-only'),
                  replayVisibleEvents:
                    realtime === 'refetch' || fetchPolicy === 'network-only' || serverMaintained,
                  rebaseMembership: realtime === 'merge' && !serverMaintained,
                  refetchEvents: realtime === 'refetch',
                  realtimeStrategy:
                    realtime === 'disabled'
                      ? 'manual'
                      : realtime === 'refetch' || serverMaintained
                        ? 'refetch'
                        : 'merge',
                },
                label,
              )
              t.is(
                maintenance.matches({}),
                realtime === 'merge' && classification !== 'server-authoritative',
                label,
              )
              cases++
            }
          }
        }
      }
    }
  }
  t.is(cases, 1_024)
})
