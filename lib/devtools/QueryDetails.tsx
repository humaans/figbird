import {
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import type { QueryRecord, QuerySpan } from './collector.js'
import { compactJson, formatMs, now } from './format.js'
import { JsonViewer } from './JsonViewer.js'
import type {
  DevtoolsOperation,
  OperationPagination,
  QuerySummary,
  UnderlyingFetch,
} from './model.js'
import { ClassBadge, plural, queryStatus, QueryStatusDot } from './QueryPresentation.js'
import {
  Badge,
  CopyButton,
  DetailSection,
  DetailsPane,
  useDevtoolsTheme,
  type DevtoolsColors,
} from './ui.js'

const SPLIT_DETAILS_WIDTH = 600

export function QueryDetails({
  operation,
  selectedQueryId,
  width,
  onFetchSelect,
  onResizeStart,
  onClose,
}: {
  operation: DevtoolsOperation
  selectedQueryId: string | null
  width: number
  onFetchSelect: (span: QuerySpan) => void
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void
  onClose: () => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const requestedUnderlying = operation.underlying.find(
    item => item.query.queryId === selectedQueryId,
  )
  const requestedUnderlyingKey = requestedUnderlying
    ? underlyingFetchKey(requestedUnderlying)
    : null
  const [selectedUnderlyingKey, setSelectedUnderlyingKey] = useState<string | null>(null)
  useEffect(() => {
    setSelectedUnderlyingKey(requestedUnderlyingKey)
  }, [operation.key, requestedUnderlyingKey])

  const { summary, rootFetches, underlying, composition } = operation
  const selectedUnderlying =
    underlying.find(item => underlyingFetchKey(item) === selectedUnderlyingKey) ?? null
  const activeQuery: QuerySummary = selectedUnderlying?.query ?? summary
  const activeQueryId =
    selectedUnderlying?.query.queryId ?? (rootFetches.length === 1 ? rootFetches[0]!.queryId : null)
  const average =
    activeQuery.fetchCount > 0 ? activeQuery.totalDurationMs / activeQuery.fetchCount : 0
  const status = queryStatus(activeQuery)
  const rootTitle = composition?.operation ?? `${summary.serviceName}.${summary.method}`
  const rootOperation = composition?.operation ?? rootTitle
  const activeOperation = `${activeQuery.serviceName}.${activeQuery.method}`
  const splitDetails = width >= SPLIT_DETAILS_WIDTH
  const rootQueryIdentity =
    rootFetches.length === 1 ? rootFetches[0]!.queryId : `${rootFetches.length} root query IDs`
  const directChildren =
    selectedUnderlying?.role === 'junction'
      ? []
      : selectedUnderlying
        ? underlying.filter(item => {
            const prefix = `${selectedUnderlying.path}.`
            if (!item.path.startsWith(prefix)) return false
            return !item.path.slice(prefix.length).includes('.')
          })
        : underlying
  const showQueryPlan = directChildren.length > 0
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
      {selectedUnderlying.path.split('.').map((segment, index, segments) => {
        const path = segments.slice(0, index + 1).join('.')
        const ancestor = underlying.find(item => item.path === path && item.role !== 'junction')
        const current = index === segments.length - 1
        return (
          <span key={path} style={{ display: 'contents' }}>
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
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
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
            {selectedUnderlying
              ? `${activeOperation} · ${activeQueryId}`
              : `${summary.method} request · ${rootQueryIdentity}`}
          </code>
          {activeQueryId ? <CopyButton value={activeQueryId} label='Query ID' /> : null}
        </span>
      }
      width={width}
      onResizeStart={onResizeStart}
      onClose={onClose}
      contentStyle={{ padding: 0, overflow: 'hidden' }}
    >
      <div
        style={{
          display: splitDetails ? 'grid' : 'block',
          gridTemplateColumns: splitDetails
            ? 'minmax(280px, 0.9fr) minmax(300px, 1.1fr)'
            : undefined,
          height: '100%',
          minHeight: 0,
          overflow: splitDetails ? 'hidden' : 'auto',
        }}
      >
        <div style={{ minWidth: 0, minHeight: 0, overflow: 'auto', padding: 12 }}>
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
          {activeQuery.resourceId !== undefined ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                margin: '-3px 0 10px',
                color: colors.muted,
              }}
            >
              <span>Resource ID</span>
              <code style={{ ...styles.code, color: colors.text }}>#{activeQuery.resourceId}</code>
              <CopyButton value={String(activeQuery.resourceId)} label='Resource ID' />
            </div>
          ) : null}
          {activeQuery.lastError ? (
            <div
              title={`Most recently observed fetch error · query generation ${activeQuery.lastError.generation}`}
              style={{
                color: colors.red,
                background: colors.panel2,
                borderLeft: `3px solid ${colors.red}`,
                padding: '7px 9px',
                marginBottom: 10,
              }}
            >
              <div style={{ fontWeight: 650, marginBottom: 2 }}>Last fetch error</div>
              {activeQuery.lastError.message}
            </div>
          ) : null}
          <QueryPerformance query={activeQuery} average={average} onFetchSelect={onFetchSelect} />
          <QueryRealtimeUpdates query={activeQuery} />
          {!splitDetails ? <QueryData query={activeQuery} separated /> : null}
          <QueryDetailBlock separated>
            <JsonViewer
              value={queryArguments(activeQuery)}
              label={activeQuery.method === 'get' ? 'Arguments' : 'Parameters'}
            />
          </QueryDetailBlock>
          {!selectedUnderlying && operation.pagination ? (
            <PaginationDetails pagination={operation.pagination} pages={rootFetches} />
          ) : null}
          {showQueryPlan ? (
            <DetailSection
              label={selectedUnderlying ? 'Related queries' : 'Query plan'}
              meta={plural(directChildren.length, 'relation', 'relations')}
              separated
            >
              {!selectedUnderlying ? (
                <QueryPlanRow path='root' operation={rootOperation} detail='' />
              ) : null}
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
                      selectedUnderlying ? (item.path.split('.').pop() ?? item.path) : item.path
                    }
                    operation={`${item.query.serviceName}.${item.query.method}`}
                    {...(item.role ? { role: item.role } : {})}
                    detail={[
                      plural(item.query.itemCount, 'row', 'rows'),
                      item.query.lastDurationMs === undefined
                        ? undefined
                        : formatMs(item.query.lastDurationMs),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    onSelect={() => setSelectedUnderlyingKey(underlyingFetchKey(item))}
                  />
                ))}
              </div>
            </DetailSection>
          ) : null}
        </div>
        {splitDetails ? (
          <div
            style={{
              minWidth: 0,
              minHeight: 0,
              overflow: 'auto',
              padding: 12,
              borderLeft: `1px solid ${colors.border}`,
              background: colors.bg,
            }}
          >
            <QueryData query={activeQuery} fill />
          </div>
        ) : null}
      </div>
    </DetailsPane>
  )
}

function queryArguments(query: QuerySummary): unknown {
  if (query.method !== 'get') return query.query ?? {}
  if (query.resourceId === undefined) return query.query ?? {}
  return {
    id: query.resourceId,
    ...(query.query && Object.keys(query.query).length > 0 ? { query: query.query } : {}),
  }
}

function QueryData({
  query,
  fill = false,
  separated = false,
}: {
  query: QuerySummary
  fill?: boolean
  separated?: boolean
}) {
  return (
    <QueryDetailBlock separated={separated}>
      <JsonViewer
        value={query.data}
        label='Query data'
        meta={query.skipped ? 'skipped' : plural(query.itemCount, 'row', 'rows')}
        maxHeight={fill ? 'none' : 360}
      />
    </QueryDetailBlock>
  )
}

function QueryRealtimeUpdates({ query }: { query: QuerySummary }) {
  const { colors } = useDevtoolsTheme()
  return (
    <DetailSection label='Realtime Updates' separated>
      <div style={{ color: colors.text, fontWeight: 600 }}>{realtimeUpdatesLabel(query)}</div>
      <div style={{ color: colors.muted, marginTop: 2 }}>{realtimeUpdatesDescription(query)}</div>
    </DetailSection>
  )
}

function realtimeUpdatesLabel(query: QuerySummary): string {
  switch (realtimeUpdatesMode(query)) {
    case 'merge':
      return 'Merges matching events locally'
    case 'manual':
      return 'Ignores realtime events'
    default:
      return 'Refetches uncertain events'
  }
}

function realtimeUpdatesDescription(query: QuerySummary): string {
  const mode = realtimeUpdatesMode(query)
  if (mode === 'manual') {
    return 'This snapshot changes only when it is refetched manually.'
  }
  if (mode === 'merge') {
    return 'Matching cache changes can be applied safely without refetching.'
  }

  const reasons = query.classificationReasons ?? []
  const windowReasons = reasons.filter(reason => reason.code === 'window-filter')
  if (windowReasons.length > 0) {
    return 'Sorted or paginated results can’t always be updated safely in place.'
  }
  return 'The server is needed when an event can’t be applied safely in place.'
}

function realtimeUpdatesMode(query: QuerySummary): 'merge' | 'manual' | 'refetch' {
  if (query.realtimeStrategy) return query.realtimeStrategy
  if (query.classificationReasons?.some(reason => reason.code === 'snapshot')) return 'manual'
  if (query.classification === 'local-exact' || query.classification === 'get') return 'merge'
  return 'refetch'
}

function PaginationDetails({
  pagination,
  pages,
}: {
  pagination: OperationPagination
  pages: QueryRecord[]
}) {
  const { colors, styles } = useDevtoolsTheme()
  const loadedRows = pages.reduce((total, page) => total + page.itemCount, 0)
  const summary = [
    pagination.total === undefined
      ? `${loadedRows} rows loaded`
      : `${loadedRows} of ${pagination.total} rows loaded`,
    pagination.loadedPages > 1 ? plural(pagination.loadedPages, 'page', 'pages') : undefined,
    pagination.isLoadingMore ? 'loading more' : pagination.hasMore ? 'more available' : 'complete',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <DetailSection label='Pagination' separated>
      <div style={{ color: colors.muted }}>{summary}</div>
      {pages.length > 1 ? (
        <details style={{ marginTop: 8 }}>
          <summary
            style={{
              color: colors.text,
              cursor: 'pointer',
              fontWeight: 600,
              userSelect: 'none',
            }}
          >
            Page chain
          </summary>
          <div style={{ marginTop: 5 }}>
            {pages.map((page, index) => {
              const request = page.page?.request
              const info = page.page?.info
              const position =
                pagination.strategy === 'cursor'
                  ? `after ${request?.after === undefined ? 'start' : compactJson(request.after)}`
                  : `offset ${String(page.query?.$skip ?? index * pagination.pageSize)}`
              const continuation =
                pagination.strategy === 'cursor' && info
                  ? info.hasMore
                    ? `next ${compactJson(info.endCursor)}`
                    : 'end'
                  : ''
              return (
                <div
                  key={page.queryId}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '55px minmax(0, 1fr) auto',
                    gap: 8,
                    alignItems: 'baseline',
                    padding: '4px 0 4px 14px',
                  }}
                >
                  <strong style={{ fontWeight: 600 }}>Page {index + 1}</strong>
                  <code
                    title={[position, continuation].filter(Boolean).join(' · ')}
                    style={{
                      ...styles.code,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: colors.muted,
                    }}
                  >
                    {[position, continuation].filter(Boolean).join(' · ')}
                  </code>
                  <span style={{ color: colors.muted }}>
                    {plural(page.itemCount, 'row', 'rows')}
                  </span>
                </div>
              )
            })}
          </div>
        </details>
      ) : null}
    </DetailSection>
  )
}

function underlyingFetchKey(item: UnderlyingFetch): string {
  return `${item.path}:${item.role ?? ''}:${item.query.queryId}`
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

function QueryPerformance({
  query,
  average,
  onFetchSelect,
}: {
  query: QuerySummary
  average: number
  onFetchSelect: (span: QuerySpan) => void
}) {
  const { colors } = useDevtoolsTheme()
  return (
    <DetailSection label='Performance' separated>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '5px 8px',
          color: colors.muted,
        }}
      >
        {query.lastDurationMs !== undefined ? (
          <span style={{ whiteSpace: 'nowrap' }}>
            <strong style={{ color: colors.text, fontWeight: 650 }}>
              {formatMs(query.lastDurationMs)}
            </strong>{' '}
            last
          </span>
        ) : null}
        {query.fetchCount > 1 ? (
          <>
            <span aria-hidden='true' style={{ color: colors.faint }}>
              ·
            </span>
            <span style={{ whiteSpace: 'nowrap' }}>
              <strong style={{ color: colors.text, fontWeight: 650 }}>{formatMs(average)}</strong>{' '}
              average
            </span>
          </>
        ) : null}
        {query.lastDurationMs !== undefined ? (
          <span aria-hidden='true' style={{ color: colors.faint }}>
            ·
          </span>
        ) : null}
        <span style={{ whiteSpace: 'nowrap' }}>{plural(query.fetchCount, 'fetch', 'fetches')}</span>
      </div>
      {query.spans.length > 0 ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '84px minmax(0, 1fr)',
            alignItems: 'end',
            gap: 8,
            marginTop: 8,
          }}
        >
          <span style={{ color: colors.faint, fontSize: 11 }}>Recent latency</span>
          <Sparkline spans={query.spans} onSelect={onFetchSelect} />
        </div>
      ) : null}
    </DetailSection>
  )
}

function QueryDetailBlock({
  separated = false,
  children,
}: {
  separated?: boolean
  children: ReactNode
}) {
  const { colors } = useDevtoolsTheme()
  return (
    <section
      style={{
        marginBottom: 14,
        paddingTop: separated ? 12 : 0,
        borderTop: separated ? `1px solid ${colors.rowBorder}` : undefined,
      }}
    >
      {children}
    </section>
  )
}

function QueryPlanRow({
  path,
  operation,
  detail,
  role,
  onSelect,
}: {
  path: string
  operation: string
  detail: string
  role?: 'junction'
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
        padding: '4px 0',
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
              color: onSelect ? colors.blue : colors.text,
            }}
          >
            {operation}
          </strong>
          {role === 'junction' ? <Badge tone='neutral'>junction</Badge> : null}
        </div>
        {detail ? (
          <div
            title={detail}
            style={{
              ...styles.code,
              color: colors.muted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginTop: 2,
            }}
          >
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Sparkline({
  spans,
  onSelect,
}: {
  spans: QueryRecord['spans']
  onSelect: (span: QuerySpan) => void
}) {
  const { colors } = useDevtoolsTheme()
  if (spans.length === 0) return null
  const nowPoint = now()
  const visibleSpans = spans.slice(-30)
  const max = Math.max(1, ...visibleSpans.map(span => spanDuration(span, nowPoint)))
  return (
    <span
      aria-label='Recent fetch history'
      style={{ display: 'flex', alignItems: 'end', gap: 1, height: 22 }}
    >
      {visibleSpans.map((span, index) => {
        const duration = spanDuration(span, nowPoint)
        const state = span.endAt === undefined ? 'pending' : span.ok === false ? 'error' : 'success'
        const trigger = fetchReasonLabel(span.reason)
        return (
          <button
            type='button'
            key={`${span.startAt}:${index}`}
            aria-label={`${formatMs(duration)}, ${state}, ${trigger}`}
            title={`${formatMs(duration)} · ${state}\nTrigger: ${trigger}\nClick to inspect this fetch`}
            onClick={() => onSelect(span)}
            style={{
              display: 'flex',
              alignItems: 'end',
              justifyContent: 'center',
              width: 7,
              height: 22,
              padding: 0,
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            <span
              aria-hidden='true'
              style={{
                width: 4,
                height: Math.max(3, (duration / max) * 20),
                background:
                  span.endAt === undefined
                    ? colors.blue
                    : span.ok === false
                      ? colors.red
                      : colors.green,
                borderRadius: 2,
                opacity: span.endAt === undefined ? 0.75 : 1,
                boxShadow: span.endAt === undefined ? `inset 0 0 0 1px ${colors.bg}` : undefined,
              }}
            />
          </button>
        )
      })}
    </span>
  )
}

function spanDuration(span: QuerySpan, nowPoint: number): number {
  return Math.max(0, (span.endAt ?? nowPoint) - span.startAt)
}

function fetchReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case 'subscription':
      return 'subscription'
    case 'manual':
      return 'manual refetch'
    case 'reconcile':
      return 'realtime reconciliation'
    case 'retry':
      return 'retry'
    case 'follow-up':
      return 'follow-up fetch'
    default:
      return 'unknown trigger'
  }
}
