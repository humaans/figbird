import { useState, type CSSProperties } from 'react'
import { compactJson, formatAge, formatMs } from './format.js'
import type { DevtoolsModel, DevtoolsOperation, QuerySummary } from './model.js'
import { QueryDetails } from './QueryDetails.js'
import { ClassBadge, plural, QueryStatusDot } from './QueryPresentation.js'
import { useDetailsPaneWidth, useDevtoolsTheme } from './ui.js'

interface QueryRow {
  operation: DevtoolsOperation
  localSubscriberCount: number
}

const QUERY_COLUMNS = [
  {
    label: 'query',
    width: '18%',
    description:
      'Root query operation. The dot shows its state: green active, amber cached, blue fetching, red error, or gray retained history.',
  },
  {
    label: 'shape',
    width: '38%',
    description:
      'Query method, parameters, related data, and the number of underlying relation fetches.',
  },
  {
    label: 'class',
    width: '12%',
    description:
      'How Figbird maintains the result.\nlocal-exact: membership and ordering are provable locally.\nserver-window: a limited or sorted server result; uncertain changes trigger a refetch.\nserver-authoritative: the server decides membership; cursor queries may still merge updates proven not to move page boundaries.\nget: a direct lookup by ID.',
  },
  {
    label: 'rows',
    width: '7%',
    description: 'Number of items currently in the query result.',
  },
  {
    label: 'fetches',
    width: '11%',
    description:
      'Completed fetch attempts · realtime service events observed while the query was active · event-driven refetches · failed fetches. Extra counts appear only when non-zero.',
  },
  {
    label: 'last',
    width: '7%',
    description:
      'Duration of the most recently completed fetch. "cached" or "warm" means data was available without a measured fetch in this devtools session.',
  },
  {
    label: 'age',
    width: '7%',
    description: "Time since this query's data was last fetched.",
  },
] as const

export function QueriesTab({
  model,
  filter,
  activeOnly,
  inspectedQueryCounts,
}: {
  model: DevtoolsModel
  filter: string
  activeOnly: boolean
  inspectedQueryCounts: ReadonlyMap<string, number> | null
}) {
  const { colors, styles } = useDevtoolsTheme()
  const [selectedOperationKey, setSelectedOperationKey] = useState<string | null>(null)
  const [detailsWidth, onDetailsResizeStart] = useDetailsPaneWidth()
  const rows: QueryRow[] = model.operations.flatMap(operation => {
    const query = operation.summary
    const localSubscriberCount = inspectedQueryCounts?.get(operation.key) ?? 0
    if (inspectedQueryCounts && localSubscriberCount === 0) return []
    if (
      activeOnly &&
      query.subscriberCount === 0 &&
      operation.underlying.every(item => item.query.subscriberCount === 0)
    ) {
      return []
    }
    const haystack = [
      query.serviceName,
      query.method,
      operation.composition?.detail ?? '',
      JSON.stringify(query.query ?? {}),
      ...operation.underlying.map(item =>
        [
          item.path,
          item.query.serviceName,
          item.query.method,
          JSON.stringify(item.query.query ?? {}),
        ].join(' '),
      ),
    ].join(' ')
    if (!haystack.toLowerCase().includes(filter.toLowerCase())) return []
    return [{ operation, localSubscriberCount }]
  })

  const ellipsizedCode: CSSProperties = {
    ...styles.code,
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }
  const selectedOperation = rows.find(row => row.operation.key === selectedOperationKey)?.operation

  return (
    <section style={{ height: '100%', display: 'flex', minWidth: 0 }}>
      <div style={{ ...styles.scroll, flex: 1, minHeight: 0 }}>
        <table style={styles.table}>
          <colgroup>
            {QUERY_COLUMNS.map(column => (
              <col key={column.label} style={{ width: column.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {QUERY_COLUMNS.map(column => (
                <th key={column.label} style={styles.th} title={column.description}>
                  <span
                    style={{
                      borderBottom: `1px dotted ${colors.faint}`,
                      cursor: 'help',
                    }}
                  >
                    {column.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && inspectedQueryCounts ? (
              <tr>
                <td colSpan={QUERY_COLUMNS.length} style={{ ...styles.td, color: colors.muted }}>
                  No Figbird queries are mounted in this area.
                </td>
              </tr>
            ) : null}
            {rows.map(({ operation, localSubscriberCount }) => {
              const query = operation.summary
              const isSelected = selectedOperationKey === operation.key
              return (
                <tr
                  key={operation.key}
                  tabIndex={0}
                  aria-selected={isSelected}
                  title='Select query details'
                  onClick={() => setSelectedOperationKey(operation.key)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setSelectedOperationKey(operation.key)
                    }
                  }}
                  style={{
                    cursor: 'pointer',
                    background: isSelected ? colors.activeButtonBg : colors.bg,
                    boxShadow: isSelected ? `inset 3px 0 ${colors.blue}` : undefined,
                    outline: 'none',
                  }}
                >
                  <td style={styles.td}>
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 7,
                        minWidth: 0,
                      }}
                    >
                      <span
                        aria-hidden='true'
                        style={{
                          width: 8,
                          color: isSelected ? colors.blue : colors.faint,
                          flexShrink: 0,
                          fontSize: 14,
                          lineHeight: 1,
                        }}
                      >
                        {isSelected ? '⌄' : '›'}
                      </span>
                      <QueryStatusDot query={query} />
                      <span
                        style={{
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontWeight: 650,
                        }}
                      >
                        {query.serviceName}
                        <span style={{ color: colors.muted, fontWeight: 500 }}>
                          .{query.method}
                        </span>
                      </span>
                      {inspectedQueryCounts ? (
                        <span
                          title={`${localSubscriberCount} of ${query.subscriberCount} subscribers in the selected area`}
                          style={{ color: colors.blue, whiteSpace: 'nowrap', flexShrink: 0 }}
                        >
                          {localSubscriberCount} here
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td style={{ ...styles.td, maxWidth: 420 }}>
                    <span
                      title={[
                        operation.composition?.title,
                        `params ${JSON.stringify(query.query ?? {}, null, 2)}`,
                      ]
                        .filter(Boolean)
                        .join('\n\n')}
                      style={{
                        ...ellipsizedCode,
                        color: operation.composition ? colors.text : colors.faint,
                      }}
                    >
                      {operation.composition?.detail ?? compactJson(query.query)}
                      {operation.rootFetches.length > 1
                        ? ` · ${operation.rootFetches.length} root fetches`
                        : ''}
                      {operation.underlying.length > 0
                        ? ` · ${operation.underlying.length} underlying`
                        : ''}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <ClassBadge value={query.classification} />
                  </td>
                  <td style={styles.td}>
                    <QueryRows query={query} />
                  </td>
                  <td style={styles.td}>
                    <QueryFetchStats query={query} />
                  </td>
                  <td style={styles.td}>
                    <QueryLastTiming query={query} />
                  </td>
                  <td style={styles.td}>
                    <QueryAge query={query} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {selectedOperation ? (
        <QueryDetails
          operation={selectedOperation}
          width={detailsWidth}
          onResizeStart={onDetailsResizeStart}
          onClose={() => setSelectedOperationKey(null)}
        />
      ) : null}
    </section>
  )
}

function QueryRows({ query }: { query: QuerySummary }) {
  const { colors } = useDevtoolsTheme()
  return <span style={{ color: colors.text, fontWeight: 600 }}>{query.itemCount}</span>
}

function QueryFetchStats({ query }: { query: QuerySummary }) {
  const { colors } = useDevtoolsTheme()
  const parts = [plural(query.fetchCount, 'fetch', 'fetches')]
  if (query.realtimeSeen > 0) parts.push(plural(query.realtimeSeen, 'event', 'events'))
  if (query.reconciles > 0) parts.push(plural(query.reconciles, 'refetch', 'refetches'))
  if (query.errorCount > 0) parts.push(plural(query.errorCount, 'error', 'errors'))

  return (
    <span
      style={{
        display: 'block',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: query.errorCount > 0 ? colors.red : colors.muted,
      }}
      title={parts.join('\n')}
    >
      {parts.join(' · ')}
    </span>
  )
}

function QueryLastTiming({ query }: { query: QuerySummary }) {
  const { colors } = useDevtoolsTheme()
  const duration =
    query.lastDurationMs === undefined
      ? query.fetchCount === 0 && query.fetchedAt
        ? 'cached'
        : query.fetchedAt
          ? 'warm'
          : query.isFetching
            ? 'pending'
            : '-'
      : formatMs(query.lastDurationMs)
  const mutedTiming =
    query.lastDurationMs === undefined && (duration === 'cached' || duration === 'warm')

  return (
    <span
      title={`total ${formatMs(query.totalDurationMs)}`}
      style={{
        display: 'block',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: mutedTiming ? colors.muted : colors.text,
      }}
    >
      {duration}
    </span>
  )
}

function QueryAge({ query }: { query: QuerySummary }) {
  const { colors } = useDevtoolsTheme()
  return (
    <span
      title='age since last fetch'
      style={{
        display: 'block',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: colors.muted,
      }}
    >
      {query.fetchedAt ? formatAge(Date.now() - query.fetchedAt) : '-'}
    </span>
  )
}
