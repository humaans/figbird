import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { WriteRecord } from './collector.js'
import { formatClock, formatMs, prettyJson } from './format.js'
import {
  Badge,
  DetailSection,
  DetailStat,
  DetailsPane,
  useDetailsPaneWidth,
  useDevtoolsTheme,
} from './ui.js'

export function WritesTab({ writes, inFlight }: { writes: WriteRecord[]; inFlight: number }) {
  const { colors, styles } = useDevtoolsTheme()
  const [selectedWriteId, setSelectedWriteId] = useState<string | null>(null)
  const [detailsWidth, onDetailsResizeStart] = useDetailsPaneWidth()
  const actions = writes.filter(write => write.type === 'action')
  const mutations = writes.filter(write => write.type === 'mutation')
  const selectedWrite = writes.find(write => write.id === selectedWriteId)

  return (
    <section style={{ height: '100%', display: 'flex', minWidth: 0 }}>
      <div style={{ ...styles.scroll, flex: 1, minHeight: 0 }}>
        <div
          style={{
            ...styles.writeRow,
            position: 'sticky',
            top: 0,
            zIndex: 1,
            background: colors.bg,
            color: colors.muted,
            fontWeight: 600,
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <span>Status</span>
          <span>
            Operation
            {inFlight > 0 ? (
              <span style={{ color: colors.blue, marginLeft: 8 }}>{inFlight} in flight</span>
            ) : null}
          </span>
          <span>Duration</span>
          <span>Started</span>
        </div>
        {writes.length === 0 ? (
          <div style={{ padding: 16, color: colors.muted }}>No writes recorded.</div>
        ) : (
          <>
            <SectionTitle title='Actions' count={actions.length} />
            {actions.map(write => (
              <WriteRow
                key={write.id}
                write={write}
                selected={write.id === selectedWriteId}
                onSelect={() => setSelectedWriteId(write.id)}
              />
            ))}
            <SectionTitle title='Mutations' count={mutations.length} />
            {mutations.map(write => (
              <WriteRow
                key={write.id}
                write={write}
                selected={write.id === selectedWriteId}
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

function SectionTitle({ title, count }: { title: string; count: number }) {
  const { colors } = useDevtoolsTheme()
  return (
    <div
      style={{
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
  onSelect,
}: {
  write: WriteRecord
  selected: boolean
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
        {write.optimistic ? <span style={{ color: colors.muted }}> optimistic</span> : null}
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
  const { colors, styles } = useDevtoolsTheme()
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
          <DetailStat label='Mode' value={write.optimistic ? 'optimistic' : 'confirmed'} />
        ) : null}
      </div>
      {write.error ? (
        <DetailSection label='Error'>
          <span style={{ color: colors.red }}>{write.error}</span>
        </DetailSection>
      ) : null}
      <DetailSection label='Payload'>
        <pre
          style={{
            ...styles.code,
            whiteSpace: 'pre-wrap',
            margin: 0,
            color: payload === undefined ? colors.faint : colors.text,
          }}
        >
          {payload === undefined ? 'No payload' : prettyJson(payload)}
        </pre>
      </DetailSection>
      <DetailSection label='Arguments'>
        <pre style={{ ...styles.code, whiteSpace: 'pre-wrap', margin: 0 }}>
          {prettyJson(write.args ?? [])}
        </pre>
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
