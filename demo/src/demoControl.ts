/**
 * Demo-server plumbing — deliberately not figbird. The `_demo` control service
 * lets the dev-tools panel switch the latency profile, toggle the simulated
 * teammate, arm the one-shot chaos switch, and reset the seed. It bypasses
 * figbird because it's control-plane, not data: nothing subscribes to it, and
 * it should not appear in the query inspector.
 */

import { feathersClient, figbird } from './figbird'

export type LatencyProfile = 'fast' | 'realistic' | 'slow'

export interface DemoState {
  backgroundEnabled: boolean
  latency: LatencyProfile
  /** One-shot chaos switch: the next (non-internal) mutation on the server fails. */
  chaosArmed: boolean
}

export interface DemoControl {
  getState(): Promise<DemoState>
  set(patch: Partial<DemoState>): Promise<DemoState>
  reset(): Promise<{ ok: boolean }>
}

const demoService = feathersClient.service('_demo') as unknown as {
  find(): Promise<DemoState>
  patch(id: null, data: Partial<DemoState>): Promise<DemoState>
  create(data: { action: 'reset' }): Promise<{ ok: boolean }>
}

export const demoControl: DemoControl = {
  getState: () => demoService.find(),
  set: patch => demoService.patch(null, patch),
  reset: () => demoService.create({ action: 'reset' }),
}

// Dev-only: expose the instance so you can poke figbird.inspect() / explain()
// from the browser console.
if (import.meta.env.DEV) {
  ;(window as unknown as { figbird: typeof figbird }).figbird = figbird
}
