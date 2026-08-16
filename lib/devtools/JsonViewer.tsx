import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { buttonStyle, useDevtoolsTheme } from './ui.js'

type JsonPrimitive = null | boolean | number | string
type JsonTreeValue =
  JsonPrimitive | JsonTreeValue[] | { [key: string]: JsonTreeValue } | SpecialValue

interface SpecialValue {
  __figbirdJsonSpecial: true
  text: string
}

interface NormalizationBudget {
  remaining: number
}

const MAX_JSON_CHILDREN = 500
const MAX_JSON_NODES = 5_000

export function JsonViewer({
  value,
  emptyLabel = 'No data available',
  label,
  meta,
  maxHeight = 360,
}: {
  value: unknown
  emptyLabel?: string
  label?: string
  meta?: string
  maxHeight?: number | string
}) {
  const { colors, styles } = useDevtoolsTheme()
  const [raw, setRaw] = useState(false)
  const [expandAll, setExpandAll] = useState(false)
  const normalized = useMemo(() => normalizeJson(value), [value])

  if (value === undefined && !label) {
    return (
      <div
        style={{
          ...styles.code,
          padding: 10,
          color: colors.faint,
          background: colors.panel2,
          borderRadius: 4,
        }}
      >
        {emptyLabel}
      </div>
    )
  }

  const expandable = isContainer(normalized) && childEntries(normalized).length > 0
  return (
    <div
      style={{
        border: `1px solid ${colors.rowBorder}`,
        borderRadius: 4,
        overflow: 'hidden',
        background: colors.panel2,
      }}
    >
      <div
        style={{
          minHeight: 30,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 5px 3px 9px',
          borderBottom: `1px solid ${colors.rowBorder}`,
          background: colors.toolbar,
        }}
      >
        {label ? (
          <>
            <strong style={{ color: colors.text, fontWeight: 650 }}>{label}</strong>
            {meta ? <span style={{ color: colors.muted }}>{meta}</span> : null}
          </>
        ) : (
          <code style={{ ...styles.code, color: colors.faint }}>{valueSummary(normalized)}</code>
        )}
        <span style={styles.spacer} />
        {!raw && expandable ? (
          <button
            type='button'
            style={jsonButtonStyle(colors)}
            onClick={() => setExpandAll(current => !current)}
          >
            {expandAll ? 'Collapse nested' : 'Expand all'}
          </button>
        ) : null}
        {value !== undefined ? (
          <button
            type='button'
            aria-pressed={raw}
            style={jsonButtonStyle(colors, raw)}
            onClick={() => setRaw(current => !current)}
          >
            Raw
          </button>
        ) : null}
      </div>
      <div
        style={{
          ...styles.code,
          maxHeight,
          overflow: 'auto',
          padding: '8px 10px',
          lineHeight: 1.55,
        }}
      >
        {value === undefined ? (
          <span style={{ color: colors.faint }}>{emptyLabel}</span>
        ) : raw ? (
          <pre
            style={{
              font: 'inherit',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              margin: 0,
            }}
          >
            <HighlightedJson text={prettyNormalizedJson(normalized)} />
          </pre>
        ) : (
          <JsonTreeRoot value={normalized} expandAll={expandAll} />
        )}
      </div>
    </div>
  )
}

function JsonTreeRoot({ value, expandAll }: { value: JsonTreeValue; expandAll: boolean }) {
  const { colors } = useDevtoolsTheme()
  if (!isContainer(value)) return <JsonLeaf value={value} />
  const entries = childEntries(value)
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  if (entries.length === 0) return <span style={{ color: colors.muted }}>{open + close}</span>
  return (
    <div>
      <span style={{ color: colors.muted }}>{open}</span>
      <div style={{ marginLeft: 13, borderLeft: `1px solid ${colors.rowBorder}`, paddingLeft: 7 }}>
        {entries.map(([key, child], index) => (
          <JsonNode
            key={key}
            name={key}
            value={child}
            arrayItem={Array.isArray(value)}
            comma={index < entries.length - 1}
            expandAll={expandAll}
            defaultOpen={Array.isArray(value) && isContainer(child)}
          />
        ))}
      </div>
      <span style={{ color: colors.muted }}>{close}</span>
    </div>
  )
}

function JsonNode({
  name,
  value,
  arrayItem,
  comma,
  expandAll,
  defaultOpen,
}: {
  name: string
  value: JsonTreeValue
  arrayItem: boolean
  comma: boolean
  expandAll: boolean
  defaultOpen: boolean
}) {
  const { colors } = useDevtoolsTheme()
  const expandable = isContainer(value) && childEntries(value).length > 0
  const [open, setOpen] = useState(expandAll || defaultOpen)
  useEffect(() => setOpen(expandAll || defaultOpen), [defaultOpen, expandAll])
  const key = (
    <>
      <span style={{ color: arrayItem ? colors.faint : colors.blue }}>{name}</span>
      <span style={{ color: colors.muted }}>: </span>
    </>
  )

  if (!expandable) {
    return (
      <div style={{ display: 'flex', minWidth: 0 }}>
        <span aria-hidden='true' style={{ width: 14, flex: '0 0 14px' }} />
        <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          {key}
          <JsonLeaf value={value} />
          {comma ? <span style={{ color: colors.muted }}>,</span> : null}
        </span>
      </div>
    )
  }

  const entries = childEntries(value)
  const [opening, closing] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  return (
    <div>
      <div style={{ display: 'flex', minWidth: 0 }}>
        <button
          type='button'
          aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`}
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
          style={{
            width: 14,
            flex: '0 0 14px',
            padding: 0,
            border: 0,
            background: 'transparent',
            color: colors.faint,
            font: 'inherit',
            lineHeight: 'inherit',
            cursor: 'pointer',
          }}
        >
          {open ? '▾' : '▸'}
        </button>
        <button
          type='button'
          onClick={() => setOpen(current => !current)}
          style={{
            minWidth: 0,
            padding: 0,
            border: 0,
            background: 'transparent',
            color: colors.text,
            font: 'inherit',
            lineHeight: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          {key}
          <span style={{ color: colors.muted }}>{open ? opening : `${opening}…${closing}`}</span>
          {!open ? (
            <span style={{ color: colors.faint, marginLeft: 6 }}>{entryCountLabel(value)}</span>
          ) : null}
          {!open && comma ? <span style={{ color: colors.muted }}>,</span> : null}
        </button>
      </div>
      {open ? (
        <>
          <div
            style={{
              marginLeft: 13,
              borderLeft: `1px solid ${colors.rowBorder}`,
              paddingLeft: 7,
            }}
          >
            {entries.map(([childName, child], index) => (
              <JsonNode
                key={childName}
                name={childName}
                value={child}
                arrayItem={Array.isArray(value)}
                comma={index < entries.length - 1}
                expandAll={expandAll}
                defaultOpen={false}
              />
            ))}
          </div>
          <div style={{ marginLeft: 14, color: colors.muted }}>
            {closing}
            {comma ? ',' : ''}
          </div>
        </>
      ) : null}
    </div>
  )
}

function JsonLeaf({ value }: { value: JsonTreeValue }) {
  const { colors } = useDevtoolsTheme()
  if (isContainer(value)) {
    return <span style={{ color: colors.muted }}>{Array.isArray(value) ? '[]' : '{}'}</span>
  }
  if (isSpecial(value)) return <span style={{ color: colors.faint }}>{value.text}</span>
  if (value === null) return <span style={{ color: colors.faint }}>null</span>
  if (typeof value === 'string')
    return <span style={{ color: colors.green }}>{JSON.stringify(value)}</span>
  if (typeof value === 'number')
    return <span style={{ color: colors.purple }}>{String(value)}</span>
  return <span style={{ color: colors.amber }}>{String(value)}</span>
}

function HighlightedJson({ text }: { text: string }) {
  const { colors } = useDevtoolsTheme()
  const parts: ReactNode[] = []
  const token = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = token.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index))
    const value = match[0]
    if (match[1]) {
      const isKey = Boolean(match[2])
      parts.push(
        <span key={match.index} style={{ color: isKey ? colors.blue : colors.green }}>
          {match[1]}
        </span>,
      )
      if (match[2]) parts.push(<span key={`${match.index}:`}>{match[2]}</span>)
    } else {
      parts.push(
        <span
          key={match.index}
          style={{
            color:
              value === 'null'
                ? colors.faint
                : value === 'true' || value === 'false'
                  ? colors.amber
                  : colors.purple,
          }}
        >
          {value}
        </span>,
      )
    }
    cursor = match.index + value.length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

function normalizeJson(
  value: unknown,
  ancestors = new WeakSet<object>(),
  depth = 0,
  budget: NormalizationBudget = { remaining: MAX_JSON_NODES },
): JsonTreeValue {
  if (budget.remaining-- <= 0) return special('[Additional values omitted]')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : special(String(value))
  }
  if (typeof value === 'undefined') return special('undefined')
  if (typeof value === 'bigint') return special(`${String(value)}n`)
  if (typeof value === 'function') return special(`[Function ${value.name || 'anonymous'}]`)
  if (typeof value === 'symbol') return special(String(value))
  if (typeof value !== 'object') return special(String(value))
  if (depth >= 20) return special('[Max depth]')
  if (ancestors.has(value)) return special('[Circular]')
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return normalizeJson({ name: value.name, message: value.message }, ancestors, depth + 1, budget)
  }

  ancestors.add(value)
  let normalized: JsonTreeValue
  if (Array.isArray(value)) {
    const visible = value
      .slice(0, MAX_JSON_CHILDREN)
      .map(item => normalizeJson(item, ancestors, depth + 1, budget))
    normalized =
      value.length > visible.length
        ? [...visible, special(`[${value.length - visible.length} more items omitted]`)]
        : visible
  } else if (value instanceof Map) {
    const entries: Array<[string, JsonTreeValue]> = []
    for (const [key, item] of value) {
      if (entries.length >= MAX_JSON_CHILDREN) break
      entries.push([String(key), normalizeJson(item, ancestors, depth + 1, budget)])
    }
    if (value.size > entries.length) {
      entries.push(['…', special(`[${value.size - entries.length} more entries omitted]`)])
    }
    normalized = Object.fromEntries(entries)
  } else if (value instanceof Set) {
    const entries: JsonTreeValue[] = []
    for (const item of value) {
      if (entries.length >= MAX_JSON_CHILDREN) break
      entries.push(normalizeJson(item, ancestors, depth + 1, budget))
    }
    if (value.size > entries.length) {
      entries.push(special(`[${value.size - entries.length} more items omitted]`))
    }
    normalized = entries
  } else {
    try {
      const entries: Array<[string, JsonTreeValue]> = []
      let omitted = false
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue
        if (entries.length >= MAX_JSON_CHILDREN) {
          omitted = true
          break
        }
        entries.push([
          key,
          normalizeJson((value as Record<string, unknown>)[key], ancestors, depth + 1, budget),
        ])
      }
      if (omitted) {
        entries.push(['…', special('[More properties omitted]')])
      }
      normalized = Object.fromEntries(entries)
    } catch {
      normalized = special('[Uninspectable object]')
    }
  }
  ancestors.delete(value)
  return normalized
}

function prettyNormalizedJson(value: JsonTreeValue): string {
  return (
    JSON.stringify(value, (_key, item: unknown) => (isSpecial(item) ? item.text : item), 2) ??
    String(value)
  )
}

function isContainer(
  value: JsonTreeValue,
): value is JsonTreeValue[] | { [key: string]: JsonTreeValue } {
  return typeof value === 'object' && value !== null && !isSpecial(value)
}

function isSpecial(value: unknown): value is SpecialValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__figbirdJsonSpecial' in value &&
    value.__figbirdJsonSpecial === true
  )
}

function special(text: string): SpecialValue {
  return { __figbirdJsonSpecial: true, text }
}

function childEntries(value: JsonTreeValue): Array<[string, JsonTreeValue]> {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item])
  if (!isContainer(value)) return []
  return Object.entries(value)
}

function valueSummary(value: JsonTreeValue): string {
  if (Array.isArray(value)) return `Array(${value.length})`
  if (isContainer(value)) {
    const count = Object.keys(value).length
    return `${count} ${count === 1 ? 'property' : 'properties'}`
  }
  return 'Value'
}

function entryCountLabel(value: JsonTreeValue[] | { [key: string]: JsonTreeValue }): string {
  const count = childEntries(value).length
  return Array.isArray(value)
    ? `${count} ${count === 1 ? 'item' : 'items'}`
    : `${count} ${count === 1 ? 'property' : 'properties'}`
}

function jsonButtonStyle(colors: ReturnType<typeof useDevtoolsTheme>['colors'], active = false) {
  return {
    ...buttonStyle(colors, active),
    minHeight: 22,
    padding: '2px 7px',
    fontSize: 11,
  }
}
