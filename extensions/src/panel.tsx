import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { FigbirdDevtoolsPanel } from '../../lib/devtools/Devtools.js'
import { createRemoteCollector } from '../../lib/devtools/collector.js'
import { PANEL_VISIBILITY_CALLBACK, type DevtoolsPanelWindow } from './panelVisibility.js'
import { ExtensionSession } from './remote.js'

interface DevtoolsNavigationEvent {
  addListener(listener: (url: string) => void): void
  removeListener(listener: (url: string) => void): void
}

declare const chrome: { devtools: { network: { onNavigated: DevtoolsNavigationEvent } } }

function Panel() {
  const session = useMemo(() => new ExtensionSession(), [])
  const collector = useMemo(() => createRemoteCollector(), [])
  const cacheEditor = useMemo(() => ({ update: session.editCacheEntity }), [session])
  const status = useSyncExternalStore(session.subscribeStatus, session.getStatus, session.getStatus)

  useEffect(() => {
    const panelWindow = window as DevtoolsPanelWindow
    let documentVisible = document.visibilityState !== 'hidden'
    let hostVisible = true
    let running = false
    const applyVisibility = () => {
      const visible = documentVisible && hostVisible
      if (visible === running) return
      running = visible
      if (visible) {
        session.start()
      } else {
        session.stop()
      }
    }
    const updateFromDocument = () => {
      documentVisible = document.visibilityState !== 'hidden'
      applyVisibility()
    }
    panelWindow[PANEL_VISIBILITY_CALLBACK] = visible => {
      hostVisible = visible
      applyVisibility()
    }
    applyVisibility()
    document.addEventListener('visibilitychange', updateFromDocument)
    return () => {
      document.removeEventListener('visibilitychange', updateFromDocument)
      delete panelWindow[PANEL_VISIBILITY_CALLBACK]
      session.stop()
      collector.reset()
    }
  }, [collector, session])

  useEffect(() => {
    const resetForNavigation = () => session.resetForNavigation()
    chrome.devtools.network.onNavigated.addListener(resetForNavigation)
    return () => chrome.devtools.network.onNavigated.removeListener(resetForNavigation)
  }, [session])

  useEffect(() => session.subscribeReset(() => collector.reset()), [collector, session])
  useEffect(() => session.subscribeRead(frame => collector.ingest(frame)), [collector, session])

  return (
    <FigbirdDevtoolsPanel
      collector={collector}
      inspection={session.inspection}
      cacheEditor={cacheEditor}
      status={status}
    />
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('Missing extension root')
createRoot(container).render(<Panel />)
