import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'

const MIN_DETAILS_WIDTH = 280
const DEFAULT_DETAILS_WIDTH = 360
const MAX_DETAILS_WIDTH = 720

export type ColorScheme = 'light' | 'dark'
export type DevtoolsThemeMode = 'system' | ColorScheme

export interface DevtoolsColors {
  bg: string
  panel: string
  panel2: string
  toolbar: string
  border: string
  rowBorder: string
  text: string
  muted: string
  faint: string
  green: string
  amber: string
  red: string
  blue: string
  purple: string
  activeButtonBg: string
  drawerShadow: string
}

export interface DevtoolsTheme {
  colors: DevtoolsColors
  styles: ReturnType<typeof makeStyles>
}

export const lightColors: DevtoolsColors = {
  bg: '#fbfcfd',
  panel: '#ffffff',
  panel2: '#f3f5f7',
  toolbar: '#f7f9fb',
  border: '#d7dde3',
  rowBorder: '#e8edf2',
  text: '#18202a',
  muted: '#4f5b69',
  faint: '#687483',
  green: '#087f4f',
  amber: '#a76500',
  red: '#cf3030',
  blue: '#1d65d8',
  purple: '#8a3ffc',
  activeButtonBg: 'rgba(29,101,216,.1)',
  drawerShadow: '0 -18px 50px rgba(29,42,58,.2)',
}

export const darkColors: DevtoolsColors = {
  bg: '#101214',
  panel: '#171a1d',
  panel2: '#20252a',
  toolbar: '#121518',
  border: '#343b42',
  rowBorder: 'rgba(255,255,255,.06)',
  text: '#f2f4f5',
  muted: '#b4bcc5',
  faint: '#8d98a3',
  green: '#63d28f',
  amber: '#e7bd58',
  red: '#ff7777',
  blue: '#74a7ff',
  purple: '#c98cff',
  activeButtonBg: 'rgba(116,167,255,.16)',
  drawerShadow: '0 -18px 50px rgba(0,0,0,.45)',
}

const defaultTheme: DevtoolsTheme = {
  colors: lightColors,
  styles: makeStyles(lightColors),
}

export const ThemeContext = createContext<DevtoolsTheme>(defaultTheme)

export function makeStyles(colors: DevtoolsColors) {
  const input: CSSProperties = {
    width: 210,
    maxWidth: '44vw',
    height: 26,
    boxSizing: 'border-box',
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    background: colors.panel,
    color: colors.text,
    padding: '4px 8px',
    font: 'inherit',
  }
  const chevronColor = colors.muted.replace('#', '%23')
  return {
    drawer: {
      position: 'fixed',
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 2147483646,
      background: colors.bg,
      color: colors.text,
      borderTop: `1px solid ${colors.border}`,
      boxShadow: colors.drawerShadow,
      font: '12px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      display: 'flex',
      flexDirection: 'column',
    },
    resize: {
      height: 7,
      cursor: 'ns-resize',
      background: colors.panel,
      borderBottom: `1px solid ${colors.border}`,
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      minHeight: 40,
      padding: '0 10px',
      borderBottom: `1px solid ${colors.border}`,
      background: colors.panel,
      overflowX: 'auto',
    },
    brand: {
      fontWeight: 700,
      color: colors.text,
      marginRight: 2,
    },
    spacer: {
      flex: 1,
    },
    body: {
      overflow: 'hidden',
      flex: 1,
      minHeight: 0,
    },
    input,
    select: {
      ...input,
      width: 'auto',
      maxWidth: 'none',
      appearance: 'none',
      paddingRight: 30,
      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='m1 1 4 4 4-4' fill='none' stroke='${chevronColor}' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
      backgroundRepeat: 'no-repeat',
      backgroundPosition: 'right 10px center',
      backgroundSize: '10px 6px',
    },
    scroll: {
      height: '100%',
      overflow: 'auto',
    },
    table: {
      width: '100%',
      minWidth: 860,
      tableLayout: 'fixed',
      borderCollapse: 'collapse',
    },
    th: {
      textAlign: 'left',
      color: colors.text,
      fontWeight: 400,
      padding: '6px 10px',
      boxShadow: `inset 0 -1px ${colors.border}`,
      position: 'sticky',
      top: 0,
      background: colors.bg,
      zIndex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    td: {
      padding: '5px 10px',
      borderBottom: `1px solid ${colors.rowBorder}`,
      verticalAlign: 'middle',
      overflow: 'hidden',
    },
    code: {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 11,
    },
    details: {
      padding: 12,
      background: colors.panel,
      overflow: 'auto',
      minHeight: 0,
      flex: 1,
    },
    detailsPane: {
      minWidth: MIN_DETAILS_WIDTH,
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
      borderLeft: `1px solid ${colors.border}`,
      background: colors.panel,
    },
    detailsHeader: {
      minHeight: 34,
      padding: '0 10px',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      borderBottom: `1px solid ${colors.rowBorder}`,
      background: colors.toolbar,
    },
    timeline: {
      position: 'relative',
      minWidth: 900,
      padding: '6px 10px 20px',
    },
    lane: {
      display: 'grid',
      gridTemplateColumns: '220px 1fr',
      minHeight: 32,
      borderBottom: `1px solid ${colors.rowBorder}`,
    },
    laneLabel: {
      color: colors.muted,
      padding: '8px 10px 0 0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    laneTrack: {
      position: 'relative',
      minHeight: 32,
    },
    eventRow: {
      display: 'grid',
      gridTemplateColumns: '108px 132px minmax(104px, 160px) 1fr',
      gap: 10,
      padding: '5px 10px',
      borderBottom: `1px solid ${colors.rowBorder}`,
      alignItems: 'center',
    },
  } satisfies Record<string, CSSProperties>
}

export function useDevtoolsTheme(): DevtoolsTheme {
  return useContext(ThemeContext)
}

export function usePreferredColorScheme(theme: DevtoolsThemeMode): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(() => resolveColorScheme(theme))

  useEffect(() => {
    if (theme !== 'system') {
      setScheme(theme)
      return
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      setScheme('light')
      return
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setScheme(media.matches ? 'dark' : 'light')
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [theme])

  return scheme
}

export function usePopoutDocument(
  popoutWindow: Window | null,
  colorScheme: ColorScheme,
  colors: DevtoolsColors,
): void {
  useEffect(() => {
    if (!popoutWindow) return
    const { document } = popoutWindow
    document.title = 'Figbird devtools'
    let viewport = document.querySelector('meta[name="viewport"]')
    if (!viewport) {
      viewport = document.createElement('meta')
      viewport.setAttribute('name', 'viewport')
      document.head.append(viewport)
    }
    viewport.setAttribute('content', 'width=device-width, initial-scale=1')
    document.documentElement.style.background = colors.bg
    document.documentElement.style.colorScheme = colorScheme
    document.documentElement.style.fontSize = '11px'
    document.documentElement.style.setProperty('text-size-adjust', 'none')
    document.documentElement.style.setProperty('-webkit-text-size-adjust', 'none')
    document.body.style.margin = '0'
    document.body.style.overflow = 'hidden'
    document.body.style.background = colors.bg
    document.body.style.color = colors.text
    document.body.style.fontSize = '11px'
  }, [colorScheme, colors, popoutWindow])
}

function resolveColorScheme(theme: DevtoolsThemeMode): ColorScheme {
  if (theme !== 'system') return theme
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function buttonStyle(colors: DevtoolsColors, active: boolean): CSSProperties {
  return {
    border: `1px solid ${active ? colors.blue : colors.border}`,
    borderRadius: 4,
    background: active ? colors.activeButtonBg : colors.panel2,
    color: active ? colors.text : colors.muted,
    font: 'inherit',
    padding: '4px 7px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
}

export function iconButtonStyle(colors: DevtoolsColors): CSSProperties {
  return {
    width: 24,
    height: 24,
    display: 'inline-grid',
    flexShrink: 0,
    placeItems: 'center',
    padding: 0,
    border: 'none',
    borderRadius: 3,
    background: 'transparent',
    color: colors.muted,
    font: '16px/1 ui-sans-serif, system-ui, sans-serif',
    cursor: 'pointer',
  }
}

export function DetailsPane({
  title,
  subtitle,
  width,
  onResizeStart,
  onClose,
  contentStyle,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  width: number
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void
  onClose: () => void
  contentStyle?: CSSProperties
  children: ReactNode
}) {
  const { colors, styles } = useDevtoolsTheme()
  return (
    <aside style={{ ...styles.detailsPane, flex: `0 0 ${width}px`, width }}>
      <div
        role='separator'
        aria-label='Resize details pane'
        aria-orientation='vertical'
        title='Resize details pane'
        onMouseDown={onResizeStart}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: -4,
          width: 8,
          zIndex: 2,
          cursor: 'col-resize',
        }}
      >
        <span
          aria-hidden='true'
          style={{
            position: 'absolute',
            top: '50%',
            left: 3,
            width: 2,
            height: 28,
            marginTop: -14,
            borderRadius: 2,
            background: colors.border,
          }}
        />
      </div>
      <div style={styles.detailsHeader}>
        <strong
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            minWidth: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </strong>
        {subtitle ? (
          <span
            style={{
              color: colors.muted,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {subtitle}
          </span>
        ) : null}
        <span style={styles.spacer} />
        <button
          type='button'
          aria-label='Close details'
          title='Close details'
          style={iconButtonStyle(colors)}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div style={{ ...styles.details, ...contentStyle }}>{children}</div>
    </aside>
  )
}

export function DetailSection({
  label,
  meta,
  separated = false,
  children,
}: {
  label: string
  meta?: string
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

export function DetailBlock({ children }: { children: ReactNode }) {
  return <section style={{ marginBottom: 12 }}>{children}</section>
}

export function DetailStats({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: '8px 16px',
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  )
}

export function DetailStat({
  label,
  value,
  copyValue,
}: {
  label: string
  value: string
  copyValue?: string
}) {
  const { colors } = useDevtoolsTheme()
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '82px minmax(0, 1fr)',
        gap: 6,
        alignItems: 'baseline',
        minWidth: 0,
      }}
    >
      <span style={{ color: colors.muted }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 }}>
        <span style={{ color: colors.text, minWidth: 0, overflowWrap: 'anywhere' }}>{value}</span>
        {copyValue ? <CopyButton value={copyValue} /> : null}
      </span>
    </div>
  )
}

export function CopyButton({ value, label = 'value' }: { value: string; label?: string }) {
  const { colors } = useDevtoolsTheme()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type='button'
      aria-label={`Copy ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      onClick={event => {
        event.stopPropagation()
        void copyText(value).then(success => {
          if (!success) return
          setCopied(true)
          setTimeout(() => setCopied(false), 1_200)
        })
      }}
      style={{
        flex: '0 0 auto',
        border: 0,
        padding: 0,
        background: 'transparent',
        color: copied ? colors.green : colors.faint,
        font: 'inherit',
        fontSize: 11,
        lineHeight: 1,
        cursor: 'pointer',
      }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  )
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(value)
      return true
    }
    if (typeof document === 'undefined') return false
    const input = document.createElement('textarea')
    input.value = value
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.append(input)
    input.select()
    const copied = document.execCommand('copy')
    input.remove()
    return copied
  } catch {
    return false
  }
}

export interface ResizableColumn {
  width: number
  minWidth: number
}

export function useResizableColumns(
  columns: readonly ResizableColumn[],
): [number[], (index: number, event: ReactMouseEvent<HTMLElement>) => void] {
  const [widths, setWidths] = useState<number[]>(() => columns.map(column => column.width))
  const onResizeStart = useCallback(
    (index: number, event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      const ownerWindow = event.currentTarget.ownerDocument.defaultView ?? window
      const startX = event.clientX
      const startWidth = widths[index]!
      const minWidth = columns[index]!.minWidth
      const onMove = (move: MouseEvent) => {
        setWidths(current =>
          current.map((width, columnIndex) =>
            columnIndex === index ? Math.max(minWidth, startWidth + move.clientX - startX) : width,
          ),
        )
      }
      const onUp = () => {
        ownerWindow.removeEventListener('mousemove', onMove)
        ownerWindow.removeEventListener('mouseup', onUp)
      }
      ownerWindow.addEventListener('mousemove', onMove)
      ownerWindow.addEventListener('mouseup', onUp)
    },
    [columns, widths],
  )
  return [widths, onResizeStart]
}

export function ColumnResizeHandle({
  label,
  onMouseDown,
}: {
  label: string
  onMouseDown: (event: ReactMouseEvent<HTMLSpanElement>) => void
}) {
  const { colors } = useDevtoolsTheme()
  return (
    <span
      role='separator'
      aria-label={`Resize ${label} column`}
      aria-orientation='vertical'
      title={`Resize ${label} column`}
      onMouseDown={onMouseDown}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 8,
        cursor: 'col-resize',
        zIndex: 2,
      }}
    >
      <span
        aria-hidden='true'
        style={{
          position: 'absolute',
          top: '50%',
          right: 0,
          height: 14,
          transform: 'translateY(-50%)',
          borderRight: `1px solid ${colors.border}`,
        }}
      />
    </span>
  )
}

export function resizableGridTemplate(widths: readonly number[], flexibleIndex: number): string {
  return widths
    .map((width, index) => (index === flexibleIndex ? `minmax(${width}px, 1fr)` : `${width}px`))
    .join(' ')
}

export function useDetailsPaneWidth({
  defaultWidth = DEFAULT_DETAILS_WIDTH,
  maxWidth = MAX_DETAILS_WIDTH,
}: {
  defaultWidth?: number
  maxWidth?: number
} = {}): [number, (event: ReactMouseEvent<HTMLDivElement>) => void] {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return defaultWidth
    return Math.max(MIN_DETAILS_WIDTH, Math.min(defaultWidth, maxWidth, window.innerWidth * 0.65))
  })
  const onResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      const ownerWindow = event.currentTarget.ownerDocument.defaultView ?? window
      const startX = event.clientX
      const startWidth = width
      const availableMaxWidth = Math.min(maxWidth, ownerWindow.innerWidth * 0.65)
      const onMove = (move: MouseEvent) => {
        setWidth(
          Math.max(
            MIN_DETAILS_WIDTH,
            Math.min(availableMaxWidth, startWidth + startX - move.clientX),
          ),
        )
      }
      const onUp = () => {
        ownerWindow.removeEventListener('mousemove', onMove)
        ownerWindow.removeEventListener('mouseup', onUp)
      }
      ownerWindow.addEventListener('mousemove', onMove)
      ownerWindow.addEventListener('mouseup', onUp)
    },
    [maxWidth, width],
  )
  return [width, onResizeStart]
}

export function Badge({
  tone,
  children,
  title,
}: {
  tone: 'green' | 'amber' | 'red' | 'blue' | 'neutral'
  children: string
  title?: string | undefined
}) {
  const { colors } = useDevtoolsTheme()
  const color = toneColor(colors, tone)
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        alignSelf: 'center',
        minWidth: 0,
        maxWidth: '100%',
        flexShrink: 1,
        color,
        fontSize: 11,
        lineHeight: '14px',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden='true'
        style={{
          width: 6,
          height: 6,
          flexShrink: 0,
          borderRadius: 999,
          background: color,
        }}
      />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</span>
    </span>
  )
}

export function toneColor(
  colors: DevtoolsColors,
  tone: 'green' | 'amber' | 'red' | 'blue' | 'neutral',
): string {
  return {
    green: colors.green,
    amber: colors.amber,
    red: colors.red,
    blue: colors.blue,
    neutral: colors.muted,
  }[tone]
}
