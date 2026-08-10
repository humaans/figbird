import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { FigbirdDevtoolsPanel } from '../../lib/devtools/Devtools.js'
import { createCollector } from '../../lib/devtools/collector.js'
import { ExtensionSession } from './remote.js'

function Panel() {
  const session = useMemo(() => new ExtensionSession(), [])
  const collector = useMemo(() => createCollector(session.figbird, { heartbeatMs: 0 }), [session])
  const status = useSyncExternalStore(session.subscribeStatus, session.getStatus, session.getStatus)

  useEffect(() => {
    session.start()
    return () => session.stop()
  }, [session])

  return (
    <FigbirdDevtoolsPanel collector={collector} inspection={session.inspection} status={status} />
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('Missing extension root')
createRoot(container).render(<Panel />)
