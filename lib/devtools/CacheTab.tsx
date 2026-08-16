import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
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
import { JsonViewer } from './JsonViewer.js'
import type { DevtoolsModel } from './model.js'
import {
  Badge,
  ColumnResizeHandle,
  DetailBlock,
  DetailSection,
  DetailsPane,
  buttonStyle,
  useDetailsPaneWidth,
  useResizableColumns,
  useDevtoolsTheme,
} from './ui.js'

const CACHE_COLUMNS = [
  { label: 'Entity', width: 150, minWidth: 90 },
  { label: 'Value', width: 310, minWidth: 160 },
  { label: 'Est. Size', width: 90, minWidth: 72 },
  { label: 'Queries', width: 110, minWidth: 76 },
  { label: 'Provenance', width: 150, minWidth: 110 },
] as const

const CACHE_SIZE_DESCRIPTION =
  'Estimated UTF-8 size of the JSON-serialized cache value. This is not JavaScript heap usage.'

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
}: {
  services: DevtoolsCacheService[]
  model: DevtoolsModel
  filter: string
  editor?: DevtoolsCacheEditor
  onViewTrace?: (traceId: number) => void
  onViewQuery?: (queryId: string) => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const orderedServices = useMemo(
    () => [...services].sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
    [services],
  )
  const [serviceName, setServiceName] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [columnWidths, onColumnResizeStart] = useResizableColumns(CACHE_COLUMNS)
  const [detailsWidth, onDetailsResizeStart] = useDetailsPaneWidth()
  const tableWidth = columnWidths.reduce((sum, width) => sum + width, 0)
  const serviceSizes = useMemo(
    () =>
      new Map(
        orderedServices.map(item => [
          item.serviceName,
          item.entities.reduce(
            (total, entity) => total + (estimateSerializedBytes(entity.value) ?? 0),
            0,
          ),
        ]),
      ),
    [orderedServices],
  )
  const totalSize = [...serviceSizes.values()].reduce((total, size) => total + size, 0)

  useEffect(() => {
    if (serviceName && orderedServices.some(service => service.serviceName === serviceName)) return
    setServiceName(orderedServices[0]?.serviceName ?? null)
    setSelectedId(null)
  }, [orderedServices, serviceName])

  const service = orderedServices.find(item => item.serviceName === serviceName)
  const normalizedFilter = filter.trim().toLowerCase()
  const entities = (service?.entities ?? [])
    .filter(entity => {
      if (!normalizedFilter) return true
      return `${entity.id} ${compactJson(entity.value)}`.toLowerCase().includes(normalizedFilter)
    })
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  const selected = service?.entities.find(entity => entity.id === selectedId)

  return (
    <section style={{ height: '100%', display: 'flex', minWidth: 0 }}>
      <nav
        aria-label='Cached services'
        style={{
          width: 190,
          flex: '0 0 190px',
          overflow: 'auto',
          borderRight: `1px solid ${colors.border}`,
          background: colors.toolbar,
        }}
      >
        <div
          title={CACHE_SIZE_DESCRIPTION}
          style={{
            padding: '8px 10px',
            color: colors.muted,
            fontWeight: 650,
            borderBottom: `1px solid ${colors.border}`,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span>Normalized cache</span>
          <code style={{ ...styles.code, color: colors.faint, marginLeft: 'auto' }}>
            {formatBytes(totalSize)}
          </code>
        </div>
        {orderedServices.map(item => {
          const selectedService = item.serviceName === serviceName
          return (
            <button
              key={item.serviceName}
              type='button'
              onClick={() => {
                setServiceName(item.serviceName)
                setSelectedId(null)
              }}
              style={{
                width: '100%',
                border: 0,
                borderBottom: `1px solid ${colors.rowBorder}`,
                borderLeft: `3px solid ${selectedService ? colors.blue : 'transparent'}`,
                padding: '8px 9px',
                background: selectedService ? colors.activeButtonBg : 'transparent',
                color: colors.text,
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <strong
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.serviceName}
                </strong>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    color: colors.faint,
                    marginLeft: 'auto',
                  }}
                >
                  {item.entities.length}
                  <span aria-hidden='true'>·</span>
                  <span title={CACHE_SIZE_DESCRIPTION}>
                    {formatBytes(serviceSizes.get(item.serviceName) ?? 0)}
                  </span>
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
              </span>
            </button>
          )
        })}
      </nav>
      <div style={{ ...styles.scroll, flex: 1, minWidth: 0 }}>
        {!service ? (
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
                    {...(column.label === 'Est. Size' ? { title: CACHE_SIZE_DESCRIPTION } : {})}
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
              {entities.length === 0 ? (
                <tr>
                  <td colSpan={CACHE_COLUMNS.length} style={{ ...styles.td, color: colors.muted }}>
                    No matching cached entities.
                  </td>
                </tr>
              ) : null}
              {entities.map(entity => {
                const isSelected = entity.id === selectedId
                const estimatedSize = estimateSerializedBytes(entity.value)
                return (
                  <tr
                    key={entity.id}
                    tabIndex={0}
                    aria-selected={isSelected}
                    onClick={() => setSelectedId(entity.id)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelectedId(entity.id)
                      }
                    }}
                    style={{
                      cursor: 'pointer',
                      outline: 'none',
                      background: isSelected ? colors.activeButtonBg : undefined,
                      boxShadow: isSelected ? `inset 3px 0 ${colors.blue}` : undefined,
                    }}
                  >
                    <td style={styles.td}>
                      <code style={{ ...styles.code, fontWeight: 650 }}>#{entity.id}</code>
                    </td>
                    <td style={styles.td}>
                      <code
                        title={prettyJson(entity.value)}
                        style={{
                          ...styles.code,
                          display: 'block',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: colors.muted,
                        }}
                      >
                        {compactJson(entity.value)}
                      </code>
                    </td>
                    <td style={styles.td}>
                      <code
                        title={
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
                        <span title={formatClock(entity.lastChange.wallAt, { milliseconds: true })}>
                          <Badge
                            tone={entity.lastChange.source === 'devtools' ? 'blue' : 'neutral'}
                          >
                            {entity.lastChange.source}
                          </Badge>{' '}
                          <span style={{ color: colors.faint }}>
                            {formatAge(Date.now() - entity.lastChange.wallAt)} ago
                          </span>
                        </span>
                      ) : (
                        <span style={{ color: colors.faint }}>initial snapshot</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {service && selected ? (
        <CacheEntityDetails
          key={`${service.serviceName}:${selected.id}`}
          service={service}
          entity={selected}
          model={model}
          width={detailsWidth}
          onResizeStart={onDetailsResizeStart}
          onClose={() => setSelectedId(null)}
          {...(editor ? { editor } : {})}
          {...(onViewTrace ? { onViewTrace } : {})}
          {...(onViewQuery ? { onViewQuery } : {})}
        />
      ) : null}
    </section>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
        {entity.lastChange ? <Badge tone='neutral'>{entity.lastChange.type}</Badge> : null}
        <span style={{ color: colors.muted }}>
          {entity.queryIds.length} query{' '}
          {entity.queryIds.length === 1 ? 'membership' : 'memberships'}
        </span>
        <code title={CACHE_SIZE_DESCRIPTION} style={{ ...styles.code, color: colors.muted }}>
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
                title={`Open ${item.label} in Queries`}
                onClick={() => onViewQuery(item.queryId)}
                style={{ ...style, cursor: 'pointer' }}
              >
                {content}
              </button>
            ) : (
              <div key={item.queryId} title={item.queryId} style={style}>
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
