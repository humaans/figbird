import type { QuerySummary } from './model.js'
import { Badge, useDevtoolsTheme } from './ui.js'

export const QUERY_CLASS_DESCRIPTIONS: Record<string, string> = {
  'local-exact':
    'Figbird can prove membership and ordering from local data, so realtime events merge directly into this result.',
  'server-window':
    'This is a limited or sorted server result. Figbird merges provable changes and refetches when a change could affect the window.',
  'server-authoritative':
    'The server decides which records belong in this result. Figbird normally refetches after realtime changes; a cursor query may merge a row update when it proves that page boundaries stay valid.',
  get: 'A direct record lookup by ID.',
}

export function ClassBadge({ value }: { value: string }) {
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

export function QueryStatusDot({ query }: { query: QuerySummary }) {
  const { colors } = useDevtoolsTheme()
  const status = queryStatus(query)
  const color =
    status.kind === 'error'
      ? colors.red
      : status.kind === 'fetching'
        ? colors.blue
        : status.kind === 'retained'
          ? colors.faint
          : status.kind === 'cached'
            ? colors.amber
            : colors.green
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

export function queryStatus(query: QuerySummary): {
  kind: 'active' | 'cached' | 'error' | 'fetching' | 'retained'
  label: string
} {
  if (!query.present) {
    return { kind: 'retained', label: statusLabel(query, 'retained history') }
  }
  if (query.status === 'error') {
    return { kind: 'error', label: statusLabel(query, 'error') }
  }
  if (query.isFetching || query.status === 'loading') {
    return { kind: 'fetching', label: statusLabel(query, 'fetching') }
  }
  if (query.subscriberCount === 0) {
    return { kind: 'cached', label: statusLabel(query, 'cached') }
  }
  return { kind: 'active', label: statusLabel(query, 'active') }
}

export function plural(count: number, singular: string, pluralValue: string): string {
  return `${count} ${count === 1 ? singular : pluralValue}`
}

function statusLabel(query: QuerySummary, state: string): string {
  const subscribers =
    query.subscriberCount === 1 ? '1 subscriber' : `${query.subscriberCount} subscribers`
  return `${state} · ${subscribers} · ${query.status}`
}
