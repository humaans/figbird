import type { CSSProperties } from 'react'
import type { QueryVisibility } from './Devtools.js'
import { compactJson, formatAge, formatMs } from './format.js'
import type { DevtoolsModel, DevtoolsOperation, QuerySummary } from './model.js'
import { QueryDetails } from './QueryDetails.js'
import { ClassBadge, plural, QueryStatusDot } from './QueryPresentation.js'
import {
  ColumnResizeHandle,
  useDetailsPaneWidth,
  useResizableColumns,
  useDevtoolsTheme,
} from './ui.js'

interface QueryRow {
  operation: DevtoolsOperation
  localSubscriberCount: number
}

export function operationIsInactive(operation: DevtoolsOperation): boolean {
  const queries = [operation.summary, ...operation.underlying.map(item => item.query)]
  return (
    operation.summary.skipped !== true &&
    queries.some(query => query.present) &&
    queries.every(query => query.subscriberCount === 0)
  )
}

const QUERY_COLUMNS = [
  {
    label: 'Query',
    width: 250,
    minWidth: 150,
    description:
      'Root query operation. The dot shows its state: green active, amber cached, blue fetching, red error, or gray skipped/retained history.',
  },
  {
    label: 'Plan',
    width: 420,
    minWidth: 180,
    description: 'Query operation and parameters, followed by its related data paths.',
  },
  {
    label: 'Class',
    width: 160,
    minWidth: 105,
    description:
      'How Figbird maintains the result.\nlocal-exact: membership and ordering are provable locally.\nserver-window: a limited or sorted server result; uncertain changes trigger a refetch.\nserver-authoritative: the server decides membership; cursor queries may still merge updates proven not to move page boundaries.\nget: a direct lookup by ID.',
  },
  {
    label: 'Rows',
    width: 75,
    minWidth: 55,
    description: 'Number of items currently in the query result.',
  },
  {
    label: 'Fetches',
    width: 175,
    minWidth: 100,
    description:
      'Completed fetch attempts · realtime service events observed while the query was active · event-driven refetches · failed fetches. Extra counts appear only when non-zero.',
  },
  {
    label: 'Last',
    width: 90,
    minWidth: 65,
    description:
      'Duration of the most recently completed fetch. "cached" or "warm" means data was available without a measured fetch in this devtools session.',
  },
  {
    label: 'Age',
    width: 80,
    minWidth: 60,
    description: "Time since this query's data was last fetched.",
  },
] as const

export function QueriesTab({
  model,
  filter,
  visibility,
  inspectedQueryCounts,
  selectedQueryId,
  onSelectedQueryIdChange,
}: {
  model: DevtoolsModel
  filter: string
  visibility: QueryVisibility
  inspectedQueryCounts: ReadonlyMap<string, number> | null
  selectedQueryId: string | null
  onSelectedQueryIdChange: (queryId: string | null) => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const [columnWidths, onColumnResizeStart] = useResizableColumns(QUERY_COLUMNS)
  const [detailsWidth, onDetailsResizeStart] = useDetailsPaneWidth({ defaultWidth: 680 })
  const rows: QueryRow[] = model.operations
    .flatMap(operation => {
      const query = operation.summary
      const localSubscriberCount = inspectedQueryCounts?.get(operation.key) ?? 0
      if (inspectedQueryCounts && localSubscriberCount === 0) return []
      if (visibility === 'skipped' && query.skipped !== true) return []
      if (visibility === 'inactive' && !operationIsInactive(operation)) return []
      if (visibility === 'active' && query.skipped === true) return []
      if (
        visibility === 'active' &&
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
    .sort((a, b) => {
      const aQuery = a.operation.summary
      const bQuery = b.operation.summary
      return `${aQuery.serviceName}.${aQuery.method}`.localeCompare(
        `${bQuery.serviceName}.${bQuery.method}`,
        undefined,
        { sensitivity: 'base' },
      )
    })

  const ellipsizedCode: CSSProperties = {
    ...styles.code,
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }
  const selectedOperation = rows.find(row =>
    operationContainsQuery(row.operation, selectedQueryId),
  )?.operation
  const selectedOperationKey = selectedOperation?.key ?? null

  return (
    <section style={{ height: '100%', display: 'flex', minWidth: 0 }}>
      <div style={{ ...styles.scroll, flex: 1, minHeight: 0 }}>
        <table
          style={{ ...styles.table, minWidth: columnWidths.reduce((sum, width) => sum + width, 0) }}
        >
          <colgroup>
            {QUERY_COLUMNS.map((column, index) => (
              <col key={column.label} style={{ width: columnWidths[index] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {QUERY_COLUMNS.map((column, index) => (
                <th
                  key={column.label}
                  style={{ ...styles.th, position: 'sticky' }}
                  title={column.description}
                >
                  {column.label}
                  <ColumnResizeHandle
                    label={column.label}
                    onMouseDown={event => onColumnResizeStart(index, event)}
                  />
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
              const plan = queryPlan(operation)
              const isSelected = selectedOperationKey === operation.key
              return (
                <tr
                  key={operation.key}
                  tabIndex={0}
                  aria-selected={isSelected}
                  title='Select query details'
                  onClick={() => onSelectedQueryIdChange(operationRootQueryId(operation))}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelectedQueryIdChange(operationRootQueryId(operation))
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
                        plan,
                        operation.composition?.title,
                        query.query === undefined
                          ? undefined
                          : `Parameters\n${JSON.stringify(query.query, null, 2)}`,
                      ]
                        .filter(Boolean)
                        .join('\n\n')}
                      style={{
                        ...ellipsizedCode,
                        color: colors.text,
                      }}
                    >
                      {plan}
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
          selectedQueryId={selectedQueryId}
          width={detailsWidth}
          onResizeStart={onDetailsResizeStart}
          onClose={() => onSelectedQueryIdChange(null)}
        />
      ) : null}
    </section>
  )
}

function operationContainsQuery(operation: DevtoolsOperation, queryId: string | null): boolean {
  if (!queryId) return false
  return (
    operation.rootFetches.some(query => query.queryId === queryId) ||
    operation.underlying.some(item => item.query.queryId === queryId)
  )
}

function operationRootQueryId(operation: DevtoolsOperation): string {
  return operation.rootFetches[0]?.queryId ?? operation.key
}

function queryPlan(operation: DevtoolsOperation): string {
  if (operation.composition) return operation.composition.plan
  const query = operation.summary
  const args = [
    query.resourceId === undefined ? '' : formatPlanValue(query.resourceId),
    query.query === undefined || Object.keys(query.query).length === 0
      ? ''
      : compactJson(query.query),
  ].filter(Boolean)
  return `${query.method}(${args.join(', ')})`
}

function formatPlanValue(value: string | number): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
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
