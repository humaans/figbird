/**
 * Demo-server controls that are intentionally separate from Figbird's built-in
 * query, event, timeline, and write inspection tools.
 */

import { useEffect, useState } from 'react'
import { socket } from '../figbird'
import { demoControl, type DemoState, type LatencyProfile } from '../demoControl'

export function DemoControls() {
  const [open, setOpen] = useState(false)
  const [demoState, setDemoState] = useState<DemoState | null>(null)
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    let cancelled = false
    demoControl
      .getState()
      .then(state => {
        if (!cancelled) setDemoState(state)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])

  const applyDemoPatch = async (patch: Partial<DemoState>) => {
    if (!demoState) return
    const previous = demoState
    setDemoState({ ...demoState, ...patch })
    try {
      setDemoState(await demoControl.set(patch))
    } catch {
      setDemoState(previous)
    }
  }

  const setLatency = (latency: LatencyProfile) => void applyDemoPatch({ latency })
  const toggleTeammate = () =>
    void applyDemoPatch({ backgroundEnabled: !demoState?.backgroundEnabled })
  const armChaos = () => void applyDemoPatch({ chaosArmed: !demoState?.chaosArmed })

  const dropConnection = () => {
    const engine = (socket.io as unknown as { engine?: { close: () => void } }).engine
    engine?.close()
  }

  const resetServer = async () => {
    if (resetting || !window.confirm('Reset server state and reload the page?')) return
    setResetting(true)
    try {
      await demoControl.reset()
      window.location.reload()
    } catch {
      setResetting(false)
    }
  }

  return (
    <div className={`demo-controls ${open ? 'open' : ''}`}>
      <button className='demo-controls-toggle' onClick={() => setOpen(value => !value)}>
        {open ? 'Close controls' : 'Demo controls'}
      </button>
      {open ? (
        <div className='demo-controls-panel'>
          <span className='eyebrow'>Latency</span>
          {(['fast', 'realistic', 'slow'] as const).map(profile => (
            <button
              key={profile}
              className={`link ${demoState?.latency === profile ? 'selected' : ''}`}
              onClick={() => setLatency(profile)}
              disabled={demoState === null}
              title='Server-side simulated latency'
            >
              {profile}
            </button>
          ))}
          <span className='sep'>·</span>
          <button
            className={`link ${demoState?.backgroundEnabled ? 'selected' : ''}`}
            onClick={toggleTeammate}
            disabled={demoState === null}
            title='Toggle simulated teammate activity'
          >
            Teammate: {demoState === null ? '…' : demoState.backgroundEnabled ? 'on' : 'off'}
          </button>
          <button
            className={`link ${demoState?.chaosArmed ? 'armed' : ''}`}
            onClick={armChaos}
            disabled={demoState === null}
            title='Make the next mutation fail'
          >
            {demoState?.chaosArmed ? 'Chaos: armed' : 'Fail next mutation'}
          </button>
          <button className='link' onClick={dropConnection} title='Drop and reconnect the socket'>
            Drop socket
          </button>
          <button className='link' onClick={resetServer} disabled={resetting}>
            {resetting ? 'Resetting…' : 'Reset'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
