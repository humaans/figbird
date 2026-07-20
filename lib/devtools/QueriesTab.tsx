import {
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import type { QueryRecord } from './collector.js'
import { compactJson, formatAge, prettyJson } from './format.js'
import type {
  DevtoolsModel,
  DevtoolsOperation,
  QueryComposition,
  QueryOwner,
  UnderlyingFetch,
} from './model.js'
import {
  Badge,
  DetailsPane,
  useDetailsPaneWidth,
  useDevtoolsTheme,
  type DevtoolsColors,
} from './ui.js'

interface QueryRow {
  operation: DevtoolsOperation
  localSubscriberCount: number
}

const QUERY_COLUMNS = [
  {
    label: 'query',
    width: '18%',
    description:
      'Root query operation. The dot shows its state: green active, amber cached, blue fetching, or red error.',
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
      'How Figbird maintains the result.\nlocal-exact: membership and ordering are provable locally.\nserver-window: a limited or sorted server result; uncertain changes trigger a refetch.\nserver-authoritative: the server decides membership; realtime changes trigger a refetch.\nget: a direct lookup by ID.',
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

const QUERY_CLASS_DESCRIPTIONS: Record<string, string> = {
  'local-exact':
    'Figbird can prove membership and ordering from local data, so realtime events merge directly into this result.',
  'server-window':
    'This is a limited or sorted server result. Figbird merges provable changes and refetches when a change could affect the window.',
  'server-authoritative':
    'The server decides which records belong in this result. Realtime changes trigger a server refetch.',
  get: 'A direct record lookup by ID.',
}

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
    const query = operation.query
    const localSubscriberCount = Array.from(operation.relationalKeys).reduce(
      (count, key) => count + (inspectedQueryCounts?.get(key) ?? 0),
      0,
    )
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
          item.owner.path,
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
  const selectedOperation = rows.find(row => row.operation.key === selectedOperationKey)

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
            {rows.map(row => {
              const { operation } = row
              const query = operation.query
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
                          title={`${row.localSubscriberCount} of ${query.subscriberCount} subscribers in the selected area`}
                          style={{ color: colors.blue, whiteSpace: 'nowrap', flexShrink: 0 }}
                        >
                          {row.localSubscriberCount} here
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
          query={selectedOperation.operation.query}
          rootFetches={selectedOperation.operation.rootFetches}
          underlying={selectedOperation.operation.underlying}
          width={detailsWidth}
          onResizeStart={onDetailsResizeStart}
          onClose={() => setSelectedOperationKey(null)}
          {...(selectedOperation.operation.composition
            ? { composition: selectedOperation.operation.composition }
            : {})}
        />
      ) : null}
    </section>
  )
}

function QueryDetails({
  query,
  rootFetches,
  underlying,
  composition,
  width,
  onResizeStart,
  onClose,
}: {
  query: QueryRecord
  rootFetches: QueryRecord[]
  underlying: UnderlyingFetch[]
  composition?: QueryComposition
  width: number
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void
  onClose: () => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const [selectedUnderlyingKey, setSelectedUnderlyingKey] = useState<string | null>(null)
  useEffect(() => setSelectedUnderlyingKey(null), [query.queryId])
  const selectedUnderlying =
    underlying.find(item => underlyingFetchKey(item) === selectedUnderlyingKey) ?? null
  const activeQuery = selectedUnderlying?.query ?? query
  const average =
    activeQuery.fetchCount > 0 ? activeQuery.totalDurationMs / activeQuery.fetchCount : 0
  const status = queryStatus(activeQuery)
  const rootTitle = `${query.serviceName}.${query.method}`
  const rootOperation = composition?.operation ?? rootTitle
  const activeOperation = `${activeQuery.serviceName}.${activeQuery.method}`
  const rootQueryIdentity =
    rootFetches.length === 1 ? rootFetches[0]!.queryId : `${rootFetches.length} root query IDs`
  const directChildren = selectedUnderlying
    ? underlying.filter(item => {
        if (item.owner.label !== selectedUnderlying.owner.label) return false
        const prefix = `${selectedUnderlying.owner.path}.`
        if (!item.owner.path.startsWith(prefix)) return false
        return !item.owner.path.slice(prefix.length).includes('.')
      })
    : underlying
  const breadcrumb = selectedUnderlying ? (
    <>
      <button
        type='button'
        aria-label='Back to root query'
        onClick={() => setSelectedUnderlyingKey(null)}
        style={breadcrumbButtonStyle(colors)}
      >
        {rootTitle}
      </button>
      {selectedUnderlying.owner.path.split('.').map((segment, index, segments) => {
        const path = segments.slice(0, index + 1).join('.')
        const ancestor = underlying.find(
          item => item.owner.label === selectedUnderlying.owner.label && item.owner.path === path,
        )
        const current = index === segments.length - 1
        return (
          <span key={`${selectedUnderlying.owner.label}:${path}`} style={{ display: 'contents' }}>
            <span style={{ color: colors.faint }}>›</span>
            {current || !ancestor ? (
              <span>{segment}</span>
            ) : (
              <button
                type='button'
                onClick={() => setSelectedUnderlyingKey(underlyingFetchKey(ancestor))}
                style={breadcrumbButtonStyle(colors)}
              >
                {segment}
              </button>
            )}
          </span>
        )
      })}
    </>
  ) : (
    rootTitle
  )
  return (
    <DetailsPane
      title={breadcrumb}
      subtitle={
        <code
          title={[
            'Cache identity derived from the operation and parameters. Changing filters creates a new query ID.',
            rootFetches.length > 1 ? rootFetches.map(root => root.queryId).join('\n') : undefined,
          ]
            .filter(Boolean)
            .join('\n\n')}
          style={{
            ...styles.code,
            color: colors.muted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {selectedUnderlying ? `${activeOperation} · ${activeQuery.queryId}` : rootQueryIdentity}
        </code>
      }
      width={width}
      onResizeStart={onResizeStart}
      onClose={onClose}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          minHeight: 24,
          marginBottom: 10,
        }}
      >
        <QueryStatusDot query={activeQuery} />
        <span style={{ color: colors.text, fontWeight: 600 }}>{status.kind}</span>
        <ClassBadge value={activeQuery.classification} />
        <span style={styles.spacer} />
        <span style={{ color: colors.muted, whiteSpace: 'nowrap' }}>
          {plural(activeQuery.subscriberCount, 'subscriber', 'subscribers')}
        </span>
      </div>
      {activeQuery.lastError ? (
        <div
          style={{
            color: colors.red,
            background: colors.panel2,
            borderLeft: `3px solid ${colors.red}`,
            padding: '7px 9px',
            marginBottom: 10,
          }}
        >
          {activeQuery.lastError.message}
        </div>
      ) : null}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          borderTop: `1px solid ${colors.rowBorder}`,
          borderBottom: `1px solid ${colors.rowBorder}`,
          marginBottom: 14,
        }}
      >
        <QueryMetric value={String(activeQuery.itemCount)} label='rows' />
        <QueryMetric value={String(activeQuery.fetchCount)} label='fetches' borderLeft />
        <QueryMetric
          value={
            activeQuery.lastDurationMs === undefined
              ? '-'
              : `${Math.round(activeQuery.lastDurationMs)}ms`
          }
          label='last fetch'
          borderTop
        />
        <QueryMetric
          value={activeQuery.fetchCount === 0 ? '-' : `${Math.round(average)}ms`}
          label='average'
          borderLeft
          borderTop
        />
      </div>
      {activeQuery.spans.length > 0 ? (
        <QueryDetailSection
          label='Recent fetches'
          meta={`${Math.round(activeQuery.totalDurationMs)}ms total`}
        >
          <Sparkline spans={activeQuery.spans} />
        </QueryDetailSection>
      ) : null}
      {!selectedUnderlying || directChildren.length > 0 ? (
        <QueryDetailSection
          label={selectedUnderlying ? 'Related queries' : 'Query plan'}
          {...(directChildren.length > 0
            ? { meta: plural(directChildren.length, 'relation', 'relations') }
            : {})}
        >
          {!selectedUnderlying ? (
            <QueryPlanRow
              path='root'
              operation={rootOperation}
              detail={
                composition?.planDetail ??
                (query.method === 'get'
                  ? `id ${query.resourceId ?? '?'}`
                  : compactJson(query.query ?? {}))
              }
            />
          ) : null}
          {directChildren.length > 0 ? (
            <div
              style={{
                marginLeft: selectedUnderlying ? 0 : 7,
                paddingLeft: selectedUnderlying ? 0 : 13,
                borderLeft: selectedUnderlying ? undefined : `1px solid ${colors.border}`,
              }}
            >
              {directChildren.map(item => (
                <QueryPlanRow
                  key={underlyingFetchKey(item)}
                  path={
                    selectedUnderlying
                      ? (item.owner.path.split('.').pop() ?? item.owner.path)
                      : formatOwnerPath(item.owner)
                  }
                  operation={`${item.query.serviceName}.${item.query.method}`}
                  detail={[
                    plural(item.query.itemCount, 'row', 'rows'),
                    item.query.lastDurationMs === undefined
                      ? undefined
                      : `${Math.round(item.query.lastDurationMs)}ms`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  classification={item.query.classification}
                  onSelect={() => setSelectedUnderlyingKey(underlyingFetchKey(item))}
                />
              ))}
            </div>
          ) : null}
        </QueryDetailSection>
      ) : null}
      <details
        key={activeQuery.queryId}
        style={{
          borderTop: `1px solid ${colors.rowBorder}`,
          padding: '11px 0',
        }}
      >
        <summary
          style={{
            color: colors.text,
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Parameters
          <code
            title={prettyJson(activeQuery.query ?? {})}
            style={{
              ...styles.code,
              display: 'inline-block',
              maxWidth: 'calc(100% - 90px)',
              color: colors.muted,
              fontWeight: 400,
              marginLeft: 8,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              verticalAlign: 'bottom',
              whiteSpace: 'nowrap',
            }}
          >
            {compactJson(activeQuery.query ?? {})}
          </code>
        </summary>
        <pre
          style={{
            ...styles.code,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            margin: '9px 0 0',
            padding: 10,
            background: colors.panel2,
            borderRadius: 4,
          }}
        >
          {prettyJson(activeQuery.query ?? {})}
        </pre>
      </details>
    </DetailsPane>
  )
}

function underlyingFetchKey(item: UnderlyingFetch): string {
  return `${item.owner.label}:${item.owner.path}:${item.query.queryId}`
}

function breadcrumbButtonStyle(colors: DevtoolsColors): CSSProperties {
  return {
    border: 0,
    background: 'transparent',
    color: colors.blue,
    padding: 0,
    font: 'inherit',
    fontWeight: 'inherit',
    cursor: 'pointer',
  }
}

function QueryMetric({
  value,
  label,
  borderLeft,
  borderTop,
}: {
  value: string
  label: string
  borderLeft?: boolean
  borderTop?: boolean
}) {
  const { colors } = useDevtoolsTheme()
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 5,
        minWidth: 0,
        padding: '9px 0',
        paddingLeft: borderLeft ? 12 : 0,
        borderLeft: borderLeft ? `1px solid ${colors.rowBorder}` : undefined,
        borderTop: borderTop ? `1px solid ${colors.rowBorder}` : undefined,
      }}
    >
      <strong style={{ color: colors.text, fontSize: 14 }}>{value}</strong>
      <span style={{ color: colors.muted, whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  )
}

function QueryDetailSection({
  label,
  meta,
  children,
}: {
  label: string
  meta?: string
  children: ReactNode
}) {
  const { colors } = useDevtoolsTheme()
  return (
    <section style={{ marginBottom: 14 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          marginBottom: 5,
        }}
      >
        <strong style={{ color: colors.text, fontWeight: 650 }}>{label}</strong>
        {meta ? <span style={{ color: colors.muted }}>{meta}</span> : null}
      </div>
      {children}
    </section>
  )
}

function QueryPlanRow({
  path,
  operation,
  detail,
  classification,
  onSelect,
}: {
  path: string
  operation: string
  detail: string
  classification?: string
  onSelect?: () => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  return (
    <div
      {...(onSelect
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-label': `Inspect nested query ${path}`,
            title: `Inspect ${path}`,
            onClick: onSelect,
            onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect()
              }
            },
          }
        : {})}
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        alignItems: 'start',
        gap: 8,
        padding: '7px 0',
        borderTop: `1px solid ${colors.rowBorder}`,
        cursor: onSelect ? 'pointer' : undefined,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 7,
            minWidth: 0,
          }}
        >
          <code style={{ ...styles.code, color: colors.faint, flexShrink: 0 }}>{path}</code>
          <strong
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: 600,
            }}
          >
            {operation}
          </strong>
        </div>
        <div
          title={detail}
          style={{
            ...styles.code,
            color: colors.muted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginTop: 3,
          }}
        >
          {detail || 'all'}
        </div>
      </div>
      {classification || onSelect ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {classification ? <ClassBadge value={classification} /> : null}
          {onSelect ? (
            <span
              aria-hidden='true'
              style={{ color: colors.blue, fontSize: 16, lineHeight: '18px' }}
            >
              ›
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function QueryStatusDot({ query }: { query: QueryRecord }) {
  const { colors } = useDevtoolsTheme()
  const status = queryStatus(query)
  const color =
    status.kind === 'error'
      ? colors.red
      : status.kind === 'fetching'
        ? colors.blue
        : status.kind === 'cached'
          ? colors.amber
          : status.kind === 'active'
            ? colors.green
            : colors.muted
  return (
    <span
      title={status.label}
      aria-label={status.label}
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: color,
        boxShadow: `0 0 0 2px ${colors.panel}`,
        flexShrink: 0,
      }}
    />
  )
}

function queryStatus(query: QueryRecord): {
  kind: 'active' | 'cached' | 'error' | 'fetching' | 'idle'
  label: string
} {
  if (query.status === 'error') {
    return { kind: 'error', label: statusLabel(query, 'error') }
  }

  if (query.isFetching || query.status === 'loading') {
    return { kind: 'fetching', label: statusLabel(query, 'fetching') }
  }

  if (query.subscriberCount === 0) {
    return { kind: 'cached', label: statusLabel(query, 'cached') }
  }

  if (query.subscriberCount > 0) return { kind: 'active', label: statusLabel(query, 'active') }
  return { kind: 'idle', label: statusLabel(query, 'idle') }
}

function statusLabel(query: QueryRecord, state: string): string {
  const subscribers =
    query.subscriberCount === 1 ? '1 subscriber' : `${query.subscriberCount} subscribers`
  return `${state} · ${subscribers} · ${query.status}`
}

function QueryRows({ query }: { query: QueryRecord }) {
  const { colors } = useDevtoolsTheme()
  return <span style={{ color: colors.text, fontWeight: 600 }}>{query.itemCount}</span>
}

function QueryFetchStats({ query }: { query: QueryRecord }) {
  const { colors } = useDevtoolsTheme()
  const parts = [plural(query.fetchCount, 'fetch', 'fetches')]
  if (query.realtimeSeen > 0) {
    parts.push(plural(query.realtimeSeen, 'event', 'events'))
  }
  if (query.reconciles > 0) {
    parts.push(plural(query.reconciles, 'refetch', 'refetches'))
  }
  if (query.errorCount > 0) {
    parts.push(plural(query.errorCount, 'error', 'errors'))
  }

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

function plural(count: number, singular: string, pluralValue: string): string {
  return `${count} ${count === 1 ? singular : pluralValue}`
}

function QueryLastTiming({ query }: { query: QueryRecord }) {
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
      : `${Math.round(query.lastDurationMs)}ms`
  const mutedTiming =
    query.lastDurationMs === undefined && (duration === 'cached' || duration === 'warm')

  return (
    <span
      title={`total ${Math.round(query.totalDurationMs)}ms`}
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

function QueryAge({ query }: { query: QueryRecord }) {
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

function ClassBadge({ value }: { value: string }) {
  const tone =
    value === 'local-exact'
      ? 'green'
      : value === 'server-window'
        ? 'amber'
        : value === 'get'
          ? 'neutral'
          : 'red'
  return (
    <Badge tone={tone} title={QUERY_CLASS_DESCRIPTIONS[value]}>
      {value}
    </Badge>
  )
}

function Sparkline({ spans }: { spans: QueryRecord['spans'] }) {
  const { colors } = useDevtoolsTheme()
  if (spans.length === 0) return null
  const max = Math.max(1, ...spans.map(span => (span.endAt ?? span.startAt) - span.startAt))
  return (
    <div style={{ display: 'flex', alignItems: 'end', gap: 2, height: 28, marginTop: 8 }}>
      {spans.slice(-30).map((span, index) => {
        const duration = (span.endAt ?? span.startAt) - span.startAt
        return (
          <span
            key={`${span.startAt}:${index}`}
            title={`${Math.round(duration)}ms`}
            style={{
              width: 4,
              height: Math.max(3, (duration / max) * 24),
              background: span.ok === false ? colors.red : colors.green,
              borderRadius: 2,
            }}
          />
        )
      })}
    </div>
  )
}

function formatOwnerPath(owner: QueryOwner): string {
  return owner.path === '(root)' ? 'root' : owner.path
}
