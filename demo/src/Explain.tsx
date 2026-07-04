import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Little ⓘ popover explaining what figbird is doing behind a piece of UI.
 * The didactic layer of the demo, without tabs full of prose. Pass `query` to
 * show the actual query/mutation shape below the description.
 * Rendered into a portal with fixed positioning so panes' overflow can't clip it.
 */
export function Explain({
  label,
  query,
  children,
}: {
  label: string
  query?: string
  children: ReactNode
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null)
  const open = pos !== null

  const toggle = () => {
    if (open) {
      setPos(null)
      return
    }
    const rect = btnRef.current!.getBoundingClientRect()
    const width = 340
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 12))
    // Flip above the button when it sits near the bottom of the viewport.
    if (rect.bottom > window.innerHeight - 320) {
      setPos({ bottom: window.innerHeight - rect.top + 8, left })
    } else {
      setPos({ top: rect.bottom + 8, left })
    }
  }

  return (
    <span className='explain'>
      <button
        ref={btnRef}
        type='button'
        className={`explain-btn${open ? ' open' : ''}`}
        onClick={toggle}
        aria-label={`How this works: ${label}`}
      >
        i
      </button>
      {open
        ? createPortal(
            <>
              <div className='explain-backdrop' onClick={() => setPos(null)} />
              <div className='explain-pop' style={pos}>
                <span className='explain-title'>{label}</span>
                {children}
                {query ? <pre className='explain-code'>{query}</pre> : null}
              </div>
            </>,
            document.body,
          )
        : null}
    </span>
  )
}
