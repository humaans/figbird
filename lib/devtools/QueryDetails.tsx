import {
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import type { QueryRecord } from './collector.js'
import { compactJson, formatMs } from './format.js'
import { JsonViewer } from './JsonViewer.js'
import type {
  DevtoolsOperation,
  OperationPagination,
  QuerySummary,
  UnderlyingFetch,
} from './model.js'
import { ClassBadge, plural, queryStatus, QueryStatusDot } from './QueryPresentation.js'
import { Badge, DetailsPane, useDevtoolsTheme, type DevtoolsColors } from './ui.js'

export function QueryDetails({
  operation,
  width,
  onResizeStart,
  onClose,
}: {
  operation: DevtoolsOperation
  width: number
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void
  onClose: () => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const [selectedUnderlyingKey, setSelectedUnderlyingKey] = useState<string | null>(null)
  useEffect(() => setSelectedUnderlyingKey(null), [operation.key])

  const { summary, rootFetches, underlying, composition } = operation
  const selectedUnderlying =
    underlying.find(item => underlyingFetchKey(item) === selectedUnderlyingKey) ?? null
  const activeQuery: QuerySummary = selectedUnderlying?.query ?? summary
  const activeQueryId = selectedUnderlying?.query.queryId
  const average =
    activeQuery.fetchCount > 0 ? activeQuery.totalDurationMs / activeQuery.fetchCount : 0
  const status = queryStatus(activeQuery)
  const rootTitle = `${summary.serviceName}.${summary.method}`
  const rootOperation = composition?.operation ?? rootTitle
  const activeOperation = `${activeQuery.serviceName}.${activeQuery.method}`
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
          {selectedUnderlying ? `${activeOperation} · ${activeQueryId}` : rootQueryIdentity}
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
      <QueryDetailSection label='Realtime handling'>
        <div
          style={{
            padding: '8px 10px',
            background: colors.panel2,
            borderLeft: `3px solid ${
              activeQuery.realtimeStrategy === 'merge'
                ? colors.green
                : activeQuery.realtimeStrategy === 'manual'
                  ? colors.faint
                  : colors.amber
            }`,
          }}
        >
          <strong style={{ fontWeight: 650 }}>
            {activeQuery.realtimeStrategy === 'merge'
              ? 'Merges events locally'
              : activeQuery.realtimeStrategy === 'manual'
                ? 'Manual realtime'
                : 'Reconciles uncertain events'}
          </strong>
          <div style={{ color: colors.muted, marginTop: 3 }}>
            {activeQuery.classificationReasons?.length
              ? activeQuery.classificationReasons.map(classificationReasonLabel).join(' · ')
              : activeQuery.classification === 'get'
                ? 'Direct entity lookup'
                : 'Membership and ordering are locally provable'}
          </div>
        </div>
      </QueryDetailSection>
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
            activeQuery.lastDurationMs === undefined ? '-' : formatMs(activeQuery.lastDurationMs)
          }
          label='last fetch'
          borderTop
        />
        <QueryMetric
          value={activeQuery.fetchCount === 0 ? '-' : formatMs(average)}
          label='average'
          borderLeft
          borderTop
        />
      </div>
      {activeQuery.spans.length > 0 ? (
        <QueryDetailSection
          label='Recent fetches'
          meta={`${formatMs(activeQuery.totalDurationMs)} total`}
        >
          <Sparkline spans={activeQuery.spans} />
        </QueryDetailSection>
      ) : null}
      {!selectedUnderlying && operation.pagination ? (
        <PaginationDetails pagination={operation.pagination} pages={rootFetches} />
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
                (summary.method === 'get'
                  ? `id ${summary.resourceId ?? '?'}`
                  : compactJson(summary.query ?? {}))
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
                  path={selectedUnderlying ? (item.path.split('.').pop() ?? item.path) : item.path}
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
                  classification={item.query.classification}
                  onSelect={() => setSelectedUnderlyingKey(underlyingFetchKey(item))}
                />
              ))}
            </div>
          ) : null}
        </QueryDetailSection>
      ) : null}
      <QueryDetailSection
        label='Query data'
        meta={activeQuery.skipped ? 'skipped' : plural(activeQuery.itemCount, 'row', 'rows')}
      >
        <JsonViewer value={activeQuery.data} />
      </QueryDetailSection>
      <QueryDetailSection label='Parameters'>
        <JsonViewer value={activeQuery.query ?? {}} />
      </QueryDetailSection>
    </DetailsPane>
  )
}

function classificationReasonLabel(reason: { code: string; detail?: string }): string {
  switch (reason.code) {
    case 'server-flag':
      return `forced server authority${reason.detail ? ` by ${reason.detail}` : ''}`
    case 'native-pagination':
      return 'native cursor pagination'
    case 'select-projection':
      return `projected rows${reason.detail ? ` via ${reason.detail}` : ''}`
    case 'server-only-operator':
      return `server-only operator ${reason.detail ?? ''}`.trim()
    case 'window-filter':
      return `window boundary ${reason.detail ?? ''}`.trim()
    case 'snapshot':
      return 'snapshot query ignores realtime'
    default:
      return reason.detail ?? reason.code
  }
}

function PaginationDetails({
  pagination,
  pages,
}: {
  pagination: OperationPagination
  pages: QueryRecord[]
}) {
  const { colors, styles } = useDevtoolsTheme()
  const state = [
    pagination.realtime === 'manual'
      ? 'manual realtime'
      : pagination.realtime === 'reconcile'
        ? 'reconciles on events'
        : 'merges stable updates',
    pagination.hasMore ? 'has more' : 'complete',
    pagination.isLoadingMore ? 'loading next page' : '',
    pagination.total !== undefined ? `${pagination.total} total` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <QueryDetailSection
      label={pagination.strategy === 'cursor' ? 'Cursor page chain' : 'Pages'}
      meta={`${pagination.loadedPages} loaded · size ${pagination.pageSize} · ${state}`}
    >
      <div style={{ borderTop: `1px solid ${colors.rowBorder}` }}>
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
                padding: '7px 0',
                borderBottom: `1px solid ${colors.rowBorder}`,
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
              <span style={{ color: colors.muted }}>{plural(page.itemCount, 'row', 'rows')}</span>
            </div>
          )
        })}
      </div>
    </QueryDetailSection>
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
  role,
  onSelect,
}: {
  path: string
  operation: string
  detail: string
  classification?: string
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
          {role === 'junction' ? <Badge tone='neutral'>junction</Badge> : null}
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
            title={formatMs(duration)}
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
