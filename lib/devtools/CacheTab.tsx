import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import {
  compactJson,
  estimateSerializedBytes,
  formatAge,
  formatBytes,
  formatClock,
  prettyJson,
} from './format.js'
import type { DevtoolsCacheEntity, DevtoolsCacheService } from './collector.js'
import { useClock } from './useClock.js'
import { JsonViewer } from './JsonViewer.js'
import type { DevtoolsModel } from './model.js'
import {
  Badge,
  ColumnResizeHandle,
  DetailBlock,
  DetailSection,
  DetailStat,
  DetailStats,
  DetailsPane,
  buttonStyle,
  useDetailsPaneWidth,
  useResizableColumns,
  useDevtoolsTheme,
  type DevtoolsColors,
} from './ui.js'

const CACHE_COLUMNS = [
  { label: 'service', width: 280, minWidth: 95 },
  { label: 'entity', width: 150, minWidth: 90 },
  { label: 'value', width: 310, minWidth: 160 },
  { label: 'est. size', width: 90, minWidth: 72 },
  { label: 'memberships', width: 110, minWidth: 76 },
  { label: 'last changed', width: 150, minWidth: 110 },
] as const

const CACHE_SIZE_DESCRIPTION =
  'Estimated UTF-8 size of the JSON-serialized cache value. This is not JavaScript heap usage.'
const CACHE_ROW_HEIGHT = 29
const CACHE_HEADER_HEIGHT = 30
const CACHE_ROW_OVERSCAN = 16
const CACHE_SERVICE_SIDEBAR_WIDTH = 280
const CACHE_SERVICE_GRID = 'minmax(0, 1fr) 32px 50px 14px'

export interface DevtoolsCacheEditor {
  update(
    serviceName: string,
    itemId: string | number,
    item: unknown,
  ): Promise<{ ok: boolean; error?: string; traceId?: number }>
}

export function CacheTab({
  services,
  model,
  filter,
  editor,
  onViewTrace,
  onViewQuery,
  requestedEntity,
  onRequestedEntityHandled,
}: {
  services: DevtoolsCacheService[]
  model: DevtoolsModel
  filter: string
  editor?: DevtoolsCacheEditor
  onViewTrace?: (traceId: number) => void
  onViewQuery?: (queryId: string) => void
  requestedEntity?: { serviceName: string; itemId: string | number } | null
  onRequestedEntityHandled?: () => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const { wallNow } = useClock()
  const orderedServices = useMemo(
    () => [...services].sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
    [services],
  )
  const [serviceName, setServiceName] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const cacheScrollRef = useRef<HTMLDivElement>(null)
  const [columnWidths, onColumnResizeStart] = useResizableColumns(CACHE_COLUMNS)
  const [detailsWidth, onDetailsResizeStart] = useDetailsPaneWidth()
  const tableWidth = columnWidths.reduce((sum, width) => sum + width, 0)
  const cacheRows = useMemo(
    () =>
      orderedServices.flatMap(service =>
        service.entities.map(entity => ({
          service,
          entity,
          preview: compactJson(entity.value),
          estimatedSize: estimateSerializedBytes(entity.value),
        })),
      ),
    [orderedServices],
  )
  const serviceSizes = useMemo(
    () =>
      cacheRows.reduce((sizes, row) => {
        sizes.set(
          row.service.serviceName,
          (sizes.get(row.service.serviceName) ?? 0) + (row.estimatedSize ?? 0),
        )
        return sizes
      }, new Map<string, number>()),
    [cacheRows],
  )
  const totalSize = [...serviceSizes.values()].reduce((total, size) => total + size, 0)
  const totalEntities = orderedServices.reduce((count, item) => count + item.entities.length, 0)

  if (serviceName && !orderedServices.some(service => service.serviceName === serviceName)) {
    setServiceName(null)
    setSelectedKey(null)
  }

  const [previousRequest, setPreviousRequest] = useState<typeof requestedEntity>(null)
  if (previousRequest !== requestedEntity) {
    setPreviousRequest(requestedEntity)
  }
  if (requestedEntity && previousRequest !== requestedEntity) {
    const service = orderedServices.find(item => item.serviceName === requestedEntity.serviceName)
    if (service) {
      const entity = service.entities.find(item => item.id === String(requestedEntity.itemId))
      setServiceName(service.serviceName)
      setSelectedKey(entity ? cacheEntityKey(service.serviceName, entity.id) : null)
    }
  }
  useEffect(() => {
    if (requestedEntity) onRequestedEntityHandled?.()
  }, [onRequestedEntityHandled, requestedEntity])

  const normalizedFilter = filter.trim().toLowerCase()
  const entries = useMemo(
    () =>
      cacheRows
        .filter(row => serviceName === null || row.service.serviceName === serviceName)
        .filter(({ service, entity, preview }) => {
          if (!normalizedFilter) return true
          return [
            service.serviceName,
            entity.id,
            preview,
            entity.queryIds.join(' '),
            entity.lastChange?.source ?? 'initial snapshot',
            entity.lastChange?.type ?? '',
          ]
            .join(' ')
            .toLowerCase()
            .includes(normalizedFilter)
        })
        .sort(
          (a, b) =>
            a.service.serviceName.localeCompare(b.service.serviceName) ||
            a.entity.id.localeCompare(b.entity.id, undefined, { numeric: true }),
        ),
    [cacheRows, normalizedFilter, serviceName],
  )
  const virtualRows = useVirtualCacheRows(
    entries.length,
    cacheScrollRef,
    `${serviceName ?? '*'}\u0000${normalizedFilter}`,
  )
  const visibleEntries = entries.slice(virtualRows.start, virtualRows.end)
  const selected = entries.find(
    ({ service, entity }) => cacheEntityKey(service.serviceName, entity.id) === selectedKey,
  )

  useEffect(() => {
    if (!selectedKey) return
    const index = entries.findIndex(
      ({ service, entity }) => cacheEntityKey(service.serviceName, entity.id) === selectedKey,
    )
    const scroll = cacheScrollRef.current
    if (index < 0 || !scroll || scroll.clientHeight === 0) return
    const top = CACHE_HEADER_HEIGHT + index * CACHE_ROW_HEIGHT
    const bottom = top + CACHE_ROW_HEIGHT
    if (top < scroll.scrollTop + CACHE_HEADER_HEIGHT) {
      scroll.scrollTop = Math.max(0, top - CACHE_HEADER_HEIGHT)
    } else if (bottom > scroll.scrollTop + scroll.clientHeight) {
      scroll.scrollTop = bottom - scroll.clientHeight
    }
  }, [entries, selectedKey])

  return (
    <section style={{ height: '100%', display: 'flex', minWidth: 0 }}>
      <nav
        aria-label='Cached services'
        style={{
          width: CACHE_SERVICE_SIDEBAR_WIDTH,
          flex: `0 0 ${CACHE_SERVICE_SIDEBAR_WIDTH}px`,
          overflow: 'auto',
          borderRight: `1px solid ${colors.border}`,
          background: colors.toolbar,
        }}
      >
        <div
          data-tooltip={CACHE_SIZE_DESCRIPTION}
          style={{
            padding: '8px 10px',
            color: colors.muted,
            fontWeight: 650,
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          Normalized cache
        </div>
        <div
          aria-hidden='true'
          style={{
            display: 'grid',
            gridTemplateColumns: CACHE_SERVICE_GRID,
            gap: 4,
            padding: '5px 9px',
            borderBottom: `1px solid ${colors.rowBorder}`,
            color: colors.faint,
            fontSize: 11,
          }}
        >
          <span>service</span>
          <span style={{ textAlign: 'right' }}>items</span>
          <span style={{ textAlign: 'right' }}>size</span>
          <span />
        </div>
        <button
          type='button'
          onClick={() => {
            setServiceName(null)
            setSelectedKey(null)
          }}
          style={cacheServiceButtonStyle(colors, serviceName === null)}
        >
          <span>All services</span>
          <span style={{ color: colors.faint, textAlign: 'right' }}>{totalEntities}</span>
          <span
            data-tooltip={CACHE_SIZE_DESCRIPTION}
            style={{ color: colors.faint, textAlign: 'right', whiteSpace: 'nowrap' }}
          >
            {formatBytes(totalSize)}
          </span>
          <span />
        </button>
        {orderedServices.map(item => {
          const selectedService = item.serviceName === serviceName
          return (
            <button
              key={item.serviceName}
              type='button'
              onClick={() => {
                setServiceName(item.serviceName)
                setSelectedKey(null)
              }}
              style={cacheServiceButtonStyle(colors, selectedService)}
            >
              <span
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.serviceName}
              </span>
              <span style={{ color: colors.faint, textAlign: 'right' }}>
                {item.entities.length}
              </span>
              <span
                data-tooltip={CACHE_SIZE_DESCRIPTION}
                style={{ color: colors.faint, textAlign: 'right', whiteSpace: 'nowrap' }}
              >
                {formatBytes(serviceSizes.get(item.serviceName) ?? 0)}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {item.materialized ? (
                  <svg
                    aria-label='Complete cached set'
                    role='img'
                    viewBox='0 0 12 12'
                    width='12'
                    height='12'
                    style={{ color: colors.green, flex: '0 0 auto' }}
                  >
                    <circle cx='6' cy='6' r='5' fill='currentColor' />
                    <path
                      d='m3.6 6 1.5 1.5 3.3-3.3'
                      fill='none'
                      stroke={colors.bg}
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      strokeWidth='1.3'
                    />
                  </svg>
                ) : null}
              </span>
            </button>
          )
        })}
      </nav>
      <div ref={cacheScrollRef} style={{ ...styles.scroll, flex: 1, minWidth: 0 }}>
        {orderedServices.length === 0 ? (
          <div style={{ padding: 16, color: colors.muted }}>No entities cached yet.</div>
        ) : (
          <table style={{ ...styles.table, minWidth: tableWidth }}>
            <colgroup>
              {CACHE_COLUMNS.map((column, index) => (
                <col key={column.label} style={{ width: columnWidths[index] }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {CACHE_COLUMNS.map((column, index) => (
                  <th
                    key={column.label}
                    style={{ ...styles.th, position: 'sticky' }}
                    {...(column.label === 'est. size'
                      ? { 'data-tooltip': CACHE_SIZE_DESCRIPTION }
                      : {})}
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
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={CACHE_COLUMNS.length} style={{ ...styles.td, color: colors.muted }}>
                    No matching cached entities.
                  </td>
                </tr>
              ) : null}
              {virtualRows.paddingTop > 0 ? (
                <CacheTableSpacer height={virtualRows.paddingTop} />
              ) : null}
              {visibleEntries.map(({ service, entity, preview, estimatedSize }) => {
                const key = cacheEntityKey(service.serviceName, entity.id)
                const isSelected = key === selectedKey
                return (
                  <tr
                    key={key}
                    tabIndex={0}
                    aria-selected={isSelected}
                    onClick={() => setSelectedKey(key)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelectedKey(key)
                      }
                    }}
                    style={{
                      cursor: 'pointer',
                      outline: 'none',
                      height: CACHE_ROW_HEIGHT,
                      background: isSelected ? colors.activeButtonBg : undefined,
                      boxShadow: isSelected ? `inset 3px 0 ${colors.blue}` : undefined,
                    }}
                  >
                    <td style={styles.td}>
                      <span style={{ fontWeight: 600 }}>{service.serviceName}</span>
                    </td>
                    <td style={styles.td}>
                      <code style={styles.code}>#{entity.id}</code>
                    </td>
                    <td style={styles.td}>
                      <code
                        data-tooltip={preview}
                        data-tooltip-overflow=''
                        style={{
                          ...styles.code,
                          display: 'block',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: colors.muted,
                        }}
                      >
                        {preview}
                      </code>
                    </td>
                    <td style={styles.td}>
                      <code
                        data-tooltip={
                          estimatedSize === null
                            ? 'This value could not be JSON-serialized.'
                            : `${estimatedSize.toLocaleString()} estimated UTF-8 JSON bytes`
                        }
                        style={{ ...styles.code, color: colors.muted, whiteSpace: 'nowrap' }}
                      >
                        {estimatedSize === null ? '—' : formatBytes(estimatedSize)}
                      </code>
                    </td>
                    <td style={styles.td}>
                      {entity.queryIds.length === 0 ? (
                        <span style={{ color: colors.faint }}>unreferenced</span>
                      ) : (
                        `${entity.queryIds.length} ${entity.queryIds.length === 1 ? 'query' : 'queries'}`
                      )}
                    </td>
                    <td style={styles.td}>
                      {entity.lastChange ? (
                        <span
                          data-tooltip={formatClock(entity.lastChange.wallAt, {
                            milliseconds: true,
                          })}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          <Badge
                            tone={entity.lastChange.source === 'devtools' ? 'blue' : 'neutral'}
                          >
                            {entity.lastChange.source}
                          </Badge>
                          <span style={{ color: colors.faint }}>
                            {formatAge(wallNow - entity.lastChange.wallAt)} ago
                          </span>
                        </span>
                      ) : (
                        <span style={{ color: colors.faint }}>initial snapshot</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {virtualRows.paddingBottom > 0 ? (
                <CacheTableSpacer height={virtualRows.paddingBottom} />
              ) : null}
            </tbody>
          </table>
        )}
      </div>
      {selected ? (
        <CacheEntityDetails
          key={cacheEntityKey(selected.service.serviceName, selected.entity.id)}
          service={selected.service}
          entity={selected.entity}
          model={model}
          width={detailsWidth}
          onResizeStart={onDetailsResizeStart}
          onClose={() => setSelectedKey(null)}
          {...(editor ? { editor } : {})}
          {...(onViewTrace ? { onViewTrace } : {})}
          {...(onViewQuery ? { onViewQuery } : {})}
        />
      ) : null}
    </section>
  )
}

function useVirtualCacheRows(
  count: number,
  scrollRef: RefObject<HTMLDivElement | null>,
  resetKey: string,
): { start: number; end: number; paddingTop: number; paddingBottom: number } {
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 64) })

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (scroll) scroll.scrollTop = 0
  }, [resetKey, scrollRef])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) {
      setRange({ start: 0, end: Math.min(count, 64) })
      return
    }
    const ownerWindow = scroll.ownerDocument.defaultView
    let frame: number | null = null
    const measure = () => {
      frame = null
      const viewportHeight = scroll.clientHeight || CACHE_ROW_HEIGHT * 48
      const bodyScrollTop = Math.max(0, scroll.scrollTop - CACHE_HEADER_HEIGHT)
      const start = Math.max(0, Math.floor(bodyScrollTop / CACHE_ROW_HEIGHT) - CACHE_ROW_OVERSCAN)
      const end = Math.min(
        count,
        Math.ceil((bodyScrollTop + viewportHeight) / CACHE_ROW_HEIGHT) + CACHE_ROW_OVERSCAN,
      )
      setRange(current =>
        current.start === start && current.end === end ? current : { start, end },
      )
    }
    const scheduleMeasure = () => {
      if (frame !== null) return
      if (ownerWindow?.requestAnimationFrame) {
        frame = ownerWindow.requestAnimationFrame(measure)
      } else {
        measure()
      }
    }

    measure()
    scroll.addEventListener('scroll', scheduleMeasure, { passive: true })
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure)
    observer?.observe(scroll)
    return () => {
      scroll.removeEventListener('scroll', scheduleMeasure)
      observer?.disconnect()
      if (frame !== null) ownerWindow?.cancelAnimationFrame(frame)
    }
  }, [count, resetKey, scrollRef])

  return {
    ...range,
    paddingTop: range.start * CACHE_ROW_HEIGHT,
    paddingBottom: Math.max(0, count - range.end) * CACHE_ROW_HEIGHT,
  }
}

function CacheTableSpacer({ height }: { height: number }) {
  return (
    <tr aria-hidden='true' style={{ height }}>
      <td colSpan={CACHE_COLUMNS.length} style={{ height, padding: 0, border: 0 }} />
    </tr>
  )
}

function CacheEntityDetails({
  service,
  entity,
  model,
  width,
  onResizeStart,
  onClose,
  editor,
  onViewTrace,
  onViewQuery,
}: {
  service: DevtoolsCacheService
  entity: DevtoolsCacheEntity
  model: DevtoolsModel
  width: number
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void
  onClose: () => void
  editor?: DevtoolsCacheEditor
  onViewTrace?: (traceId: number) => void
  onViewQuery?: (queryId: string) => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => prettyJson(entity.value))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'green' | 'red'; text: string } | null>(null)
  const [undoValue, setUndoValue] = useState<unknown | null>(null)
  const queryLabels = entity.queryIds.map(queryId => ({
    queryId,
    ...queryMembership(model, queryId),
  }))

  const update = async (value: unknown, rememberUndo: boolean) => {
    if (!editor) return
    setSaving(true)
    setMessage(null)
    try {
      const result = await editor.update(service.serviceName, entity.id, value)
      if (!result.ok) {
        setMessage({ tone: 'red', text: result.error ?? 'Cache edit failed' })
        return
      }
      if (rememberUndo) setUndoValue(entity.value)
      else setUndoValue(null)
      setEditing(false)
      setMessage({ tone: 'green', text: 'Applied in memory. No server request was sent.' })
    } catch (error) {
      setMessage({
        tone: 'red',
        text: error instanceof Error ? error.message : 'Cache edit failed',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <DetailsPane
      title={`${service.serviceName} #${entity.id}`}
      subtitle='Normalized entity'
      width={width}
      onResizeStart={onResizeStart}
      onClose={onClose}
    >
      <DetailStats>
        <DetailStat label='Service' value={service.serviceName} />
        <DetailStat label='Entity ID' value={`#${entity.id}`} copyValue={entity.id} />
      </DetailStats>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
        {entity.lastChange ? <Badge tone='neutral'>{entity.lastChange.type}</Badge> : null}
        <span style={{ color: colors.muted }}>
          {entity.queryIds.length} query{' '}
          {entity.queryIds.length === 1 ? 'membership' : 'memberships'}
        </span>
        <code data-tooltip={CACHE_SIZE_DESCRIPTION} style={{ ...styles.code, color: colors.muted }}>
          {formatEstimatedSize(entity.value)}
        </code>
        <span style={styles.spacer} />
        {editor && !editing ? (
          <button
            type='button'
            style={buttonStyle(colors, false)}
            onClick={() => {
              setDraft(prettyJson(entity.value))
              setEditing(true)
              setMessage(null)
            }}
          >
            Edit cache
          </button>
        ) : null}
      </div>

      {message ? (
        <div
          style={{
            padding: '7px 9px',
            marginBottom: 12,
            color: message.tone === 'red' ? colors.red : colors.green,
            background: colors.panel2,
            borderLeft: `3px solid ${message.tone === 'red' ? colors.red : colors.green}`,
          }}
        >
          {message.text}
          {undoValue !== null && editor ? (
            <button
              type='button'
              disabled={saving}
              onClick={() => void update(undoValue, false)}
              style={{ ...buttonStyle(colors, false), marginLeft: 8 }}
            >
              Undo
            </button>
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <DetailSection label='Edit JSON'>
          <textarea
            aria-label='Edited cache entity JSON'
            value={draft}
            onChange={event => setDraft(event.currentTarget.value)}
            spellCheck={false}
            style={{
              ...styles.code,
              width: '100%',
              minHeight: 280,
              boxSizing: 'border-box',
              resize: 'vertical',
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              padding: 10,
              background: colors.panel2,
              color: colors.text,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 8 }}>
            <span style={{ color: colors.amber, marginRight: 'auto' }}>
              In-memory only; a refetch or realtime event may overwrite this value.
            </span>
            <button
              type='button'
              disabled={saving}
              style={buttonStyle(colors, false)}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button
              type='button'
              disabled={saving}
              style={buttonStyle(colors, true)}
              onClick={() => {
                try {
                  void update(JSON.parse(draft), true)
                } catch (error) {
                  setMessage({
                    tone: 'red',
                    text: error instanceof Error ? error.message : 'Invalid JSON',
                  })
                }
              }}
            >
              {saving ? 'Applying…' : 'Apply in memory'}
            </button>
          </div>
        </DetailSection>
      ) : (
        <DetailBlock>
          <JsonViewer value={entity.value} label='Current value' />
        </DetailBlock>
      )}

      {entity.lastChange ? (
        <DetailSection label='Provenance'>
          <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: '6px 10px' }}>
            <span style={{ color: colors.faint }}>Source</span>
            <span>{entity.lastChange.source}</span>
            <span style={{ color: colors.faint }}>Operation</span>
            <span>{entity.lastChange.type}</span>
            <span style={{ color: colors.faint }}>Observed</span>
            <span>{formatClock(entity.lastChange.wallAt, { milliseconds: true })}</span>
          </div>
          {onViewTrace ? (
            <button
              type='button'
              style={{ ...buttonStyle(colors, false), marginTop: 10 }}
              onClick={() => onViewTrace(entity.lastChange!.traceId)}
            >
              View causal trace
            </button>
          ) : null}
        </DetailSection>
      ) : null}

      <DetailSection label='Query memberships'>
        {queryLabels.length === 0 ? (
          <span style={{ color: colors.faint }}>
            No retained query currently references this entity.
          </span>
        ) : (
          queryLabels.map(item => {
            const content = (
              <>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.label}
                </span>
                {item.available && onViewQuery ? (
                  <span aria-hidden='true' style={{ marginLeft: 'auto', color: colors.faint }}>
                    →
                  </span>
                ) : null}
              </>
            )
            const style: CSSProperties = {
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 0',
              border: 0,
              borderTop: `1px solid ${colors.rowBorder}`,
              background: 'transparent',
              color: item.available && onViewQuery ? colors.blue : colors.text,
              font: 'inherit',
              textAlign: 'left',
            }
            return item.available && onViewQuery ? (
              <button
                key={item.queryId}
                type='button'
                data-tooltip={`Open ${item.label} in Queries`}
                onClick={() => onViewQuery(item.queryId)}
                style={{ ...style, cursor: 'pointer' }}
              >
                {content}
              </button>
            ) : (
              <div
                key={item.queryId}
                data-tooltip={item.queryId}
                data-tooltip-overflow=''
                style={style}
              >
                {content}
              </div>
            )
          })
        )}
      </DetailSection>
    </DetailsPane>
  )
}

function queryMembership(
  model: DevtoolsModel,
  queryId: string,
): { label: string; available: boolean } {
  for (const operation of model.operations) {
    if (operation.rootFetches.some(query => query.queryId === queryId)) {
      return {
        label: `${operation.summary.serviceName}.${operation.summary.method} · root`,
        available: true,
      }
    }
    const nested = operation.underlying.find(item => item.query.queryId === queryId)
    if (nested)
      return {
        label: `${operation.summary.serviceName}.${operation.summary.method} › ${nested.path}`,
        available: true,
      }
  }
  return { label: queryId, available: false }
}

function formatEstimatedSize(value: unknown): string {
  const bytes = estimateSerializedBytes(value)
  return bytes === null ? '—' : formatBytes(bytes)
}

function cacheEntityKey(serviceName: string, entityId: string): string {
  return JSON.stringify([serviceName, entityId])
}

function cacheServiceButtonStyle(colors: DevtoolsColors, selected: boolean): CSSProperties {
  return {
    width: '100%',
    display: 'grid',
    gridTemplateColumns: CACHE_SERVICE_GRID,
    alignItems: 'center',
    gap: 4,
    border: 0,
    borderBottom: `1px solid ${colors.rowBorder}`,
    borderLeft: `3px solid ${selected ? colors.blue : 'transparent'}`,
    padding: '8px 9px',
    background: selected ? colors.activeButtonBg : 'transparent',
    color: colors.text,
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  }
}
