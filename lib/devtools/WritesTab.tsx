import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { WriteRecord } from './collector.js'
import { formatClock, formatMs } from './format.js'
import { JsonViewer } from './JsonViewer.js'
import {
  Badge,
  ColumnResizeHandle,
  DetailSection,
  DetailStat,
  DetailsPane,
  resizableGridTemplate,
  useDetailsPaneWidth,
  useResizableColumns,
  useDevtoolsTheme,
} from './ui.js'

const WRITE_COLUMNS = [
  { label: 'Status', width: 96, minWidth: 78 },
  { label: 'Operation', width: 360, minWidth: 180 },
  { label: 'Duration', width: 80, minWidth: 64 },
  { label: 'Started', width: 90, minWidth: 76 },
] as const

export function WritesTab({ writes, inFlight }: { writes: WriteRecord[]; inFlight: number }) {
  const { colors, styles } = useDevtoolsTheme()
  const [selectedWriteId, setSelectedWriteId] = useState<string | null>(null)
  const [columnWidths, onColumnResizeStart] = useResizableColumns(WRITE_COLUMNS)
  const [detailsWidth, onDetailsResizeStart] = useDetailsPaneWidth()
  const gridTemplateColumns = resizableGridTemplate(columnWidths, 1)
  const gridMinWidth =
    columnWidths.reduce((sum, width) => sum + width, 0) + (WRITE_COLUMNS.length - 1) * 8
  const actions = writes.filter(write => write.type === 'action')
  const mutations = writes.filter(write => write.type === 'mutation')
  const optimisticInFlight = mutations.filter(
    write => write.optimistic && write.status === 'in-flight',
  ).length
  const selectedWrite = writes.find(write => write.id === selectedWriteId)

  return (
    <section style={{ height: '100%', display: 'flex', minWidth: 0 }}>
      <div style={{ ...styles.scroll, flex: 1, minHeight: 0 }}>
        <div
          style={{
            ...styles.writeRow,
            gridTemplateColumns,
            minWidth: gridMinWidth,
            position: 'sticky',
            top: 0,
            zIndex: 1,
            background: colors.bg,
            color: colors.muted,
            fontWeight: 600,
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          {WRITE_COLUMNS.map((column, index) => (
            <span
              key={column.label}
              style={{
                position: 'relative',
                alignSelf: 'stretch',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {column.label}
              {index === 1 && inFlight > 0 ? (
                <span style={{ color: colors.blue, marginLeft: 8 }}>{inFlight} in flight</span>
              ) : null}
              {index === 1 && optimisticInFlight > 0 ? (
                <span
                  style={{ color: colors.amber, marginLeft: 8 }}
                  title='Already projected into the cache; may still be scheduled or saving'
                >
                  {optimisticInFlight} projected
                </span>
              ) : null}
              <ColumnResizeHandle
                label={column.label}
                onMouseDown={event => onColumnResizeStart(index, event)}
              />
            </span>
          ))}
        </div>
        {writes.length === 0 ? (
          <div style={{ padding: 16, color: colors.muted }}>No writes recorded.</div>
        ) : (
          <>
            <SectionTitle title='Actions' count={actions.length} minWidth={gridMinWidth} />
            {actions.map(write => (
              <WriteRow
                key={write.id}
                write={write}
                selected={write.id === selectedWriteId}
                gridTemplateColumns={gridTemplateColumns}
                minWidth={gridMinWidth}
                onSelect={() => setSelectedWriteId(write.id)}
              />
            ))}
            <SectionTitle title='Mutations' count={mutations.length} minWidth={gridMinWidth} />
            {mutations.map(write => (
              <WriteRow
                key={write.id}
                write={write}
                selected={write.id === selectedWriteId}
                gridTemplateColumns={gridTemplateColumns}
                minWidth={gridMinWidth}
                onSelect={() => setSelectedWriteId(write.id)}
              />
            ))}
          </>
        )}
      </div>
      {selectedWrite ? (
        <WriteDetails
          write={selectedWrite}
          width={detailsWidth}
          onResizeStart={onDetailsResizeStart}
          onClose={() => setSelectedWriteId(null)}
        />
      ) : null}
    </section>
  )
}

function SectionTitle({
  title,
  count,
  minWidth,
}: {
  title: string
  count: number
  minWidth: number
}) {
  const { colors } = useDevtoolsTheme()
  return (
    <div
      style={{
        minWidth,
        boxSizing: 'border-box',
        padding: '6px 10px',
        background: colors.toolbar,
        borderTop: `1px solid ${colors.border}`,
        borderBottom: `1px solid ${colors.rowBorder}`,
        color: colors.text,
        fontWeight: 600,
      }}
    >
      {title} <span style={{ color: colors.muted }}>{count}</span>
    </div>
  )
}

function WriteRow({
  write,
  selected,
  gridTemplateColumns,
  minWidth,
  onSelect,
}: {
  write: WriteRecord
  selected: boolean
  gridTemplateColumns: string
  minWidth: number
  onSelect: () => void
}) {
  const { colors, styles } = useDevtoolsTheme()
  const label =
    write.type === 'action'
      ? (write.name ?? '(anonymous)')
      : `${write.serviceName ?? ''}.${write.method ?? ''}${write.itemId !== undefined ? ` #${write.itemId}` : ''}`
  return (
    <div
      role='button'
      tabIndex={0}
      aria-pressed={selected}
      title='Select write details'
      onClick={onSelect}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      style={{
        ...styles.writeRow,
        gridTemplateColumns,
        minWidth,
        color: write.rolledBack || write.status === 'error' ? colors.red : colors.text,
        cursor: 'pointer',
        background: selected ? colors.activeButtonBg : undefined,
        boxShadow: selected ? `inset 3px 0 ${colors.blue}` : undefined,
        outline: 'none',
      }}
    >
      <Badge
        tone={
          write.status === 'error' || write.status === 'rollback'
            ? 'red'
            : write.status === 'in-flight'
              ? 'blue'
              : 'green'
        }
      >
        {write.status}
      </Badge>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <span style={{ color: selected ? colors.blue : colors.faint, marginRight: 6 }}>›</span>
        <strong style={{ fontWeight: 600 }}>{label}</strong>
        {write.optimistic ? (
          <span style={{ color: colors.amber }}> · optimistic projection</span>
        ) : null}
        {write.error ? <div style={{ color: colors.red }}>{write.error}</div> : null}
      </span>
      <span>{write.durationMs === undefined ? '-' : formatMs(write.durationMs)}</span>
      <span
        style={{ color: colors.faint }}
        title={formatClock(write.startedWallAt, { milliseconds: true })}
      >
        {formatClock(write.startedWallAt)}
      </span>
    </div>
  )
}

function WriteDetails({
  write,
  width,
  onResizeStart,
  onClose,
}: {
  write: WriteRecord
  width: number
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void
  onClose: () => void
}) {
  const { colors } = useDevtoolsTheme()
  const label =
    write.type === 'action'
      ? (write.name ?? '(anonymous action)')
      : `${write.serviceName ?? ''}.${write.method ?? ''}${write.itemId !== undefined ? ` #${write.itemId}` : ''}`
  const payload = writePayload(write)
  return (
    <DetailsPane
      title={label}
      subtitle={write.type === 'action' ? 'Action' : 'Mutation'}
      width={width}
      onResizeStart={onResizeStart}
      onClose={onClose}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: '8px 16px',
          marginBottom: 14,
        }}
      >
        <DetailStat label='Status' value={write.status} />
        <DetailStat
          label='Duration'
          value={write.durationMs === undefined ? '-' : formatMs(write.durationMs)}
        />
        {write.type === 'mutation' ? (
          <DetailStat
            label='Cache mode'
            value={write.optimistic ? 'projected immediately' : 'after confirmation'}
          />
        ) : null}
      </div>
      {write.error ? (
        <DetailSection label='Error'>
          <span style={{ color: colors.red }}>{write.error}</span>
        </DetailSection>
      ) : null}
      <DetailSection label='Payload'>
        <JsonViewer value={payload} emptyLabel='No payload' />
      </DetailSection>
      <DetailSection label='Arguments'>
        <JsonViewer value={write.args ?? []} />
      </DetailSection>
      <span style={{ color: colors.faint }} title={write.id}>
        Write ID
      </span>
    </DetailsPane>
  )
}

function writePayload(write: WriteRecord): unknown {
  const args = write.args
  if (!args || args.length === 0) return undefined
  if (write.type === 'action') return args.length === 1 ? args[0] : args
  if (write.method === 'create') return args[0]
  if (write.method === 'update' || write.method === 'patch') return args[1]
  if (write.method === 'remove') return undefined
  return args.length === 1 ? args[0] : args
}
