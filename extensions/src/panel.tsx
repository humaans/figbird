import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { FigbirdDevtoolsPanel } from '../../lib/devtools/Devtools.js'
import { createCollector } from '../../lib/devtools/collector.js'
import { PANEL_VISIBILITY_CALLBACK, type DevtoolsPanelWindow } from './panelVisibility.js'
import { ExtensionSession } from './remote.js'

function Panel() {
  const session = useMemo(() => new ExtensionSession(), [])
  const collector = useMemo(() => createCollector(session.figbird, { heartbeatMs: 0 }), [session])
  const cacheEditor = useMemo(() => ({ update: session.editCacheEntity }), [session])
  const status = useSyncExternalStore(session.subscribeStatus, session.getStatus, session.getStatus)

  useEffect(() => {
    const panelWindow = window as DevtoolsPanelWindow
    const setVisible = (visible: boolean) => {
      if (visible) session.start()
      else session.stop()
    }
    const updateFromDocument = () => setVisible(document.visibilityState !== 'hidden')
    panelWindow[PANEL_VISIBILITY_CALLBACK] = setVisible
    updateFromDocument()
    document.addEventListener('visibilitychange', updateFromDocument)
    return () => {
      document.removeEventListener('visibilitychange', updateFromDocument)
      delete panelWindow[PANEL_VISIBILITY_CALLBACK]
      session.stop()
    }
  }, [session])

  useEffect(() => session.subscribeReset(() => collector.reset()), [collector, session])

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
