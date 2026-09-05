import type { ReactNode } from 'react'
import { createElement, StrictMode } from 'react'
import {
  FeathersAdapter,
  Figbird,
  FigbirdProvider,
  type CustomOperatorRegistration,
  type Schema,
} from '../lib/index.js'
import {
  mockFeathers as baseMockFeathers,
  type MockFeathers,
  type MockFeathersOptions,
  type MockFeathersServices,
} from '../lib/testing.js'

// Extend the global namespace to include our custom properties
declare global {
  var __pendingEmissions: Set<object> | undefined
  var __emissionsResolves: Set<(value?: unknown) => void> | undefined
}

export function queueTask(task: () => void): void {
  if (!global.__pendingEmissions) {
    global.__pendingEmissions = new Set()
  }

  if (!global.__emissionsResolves) {
    global.__emissionsResolves = new Set()
  }

  const emissionId = {}

  global.__pendingEmissions.add(emissionId)

  setTimeout(() => {
    task()

    global.__pendingEmissions!.delete(emissionId)
    if (global.__pendingEmissions!.size === 0 && global.__emissionsResolves!.size > 0) {
      global.__emissionsResolves!.forEach(resolve => resolve())
      global.__emissionsResolves!.clear()
    }
  }, 1)
}

export async function waitForEmissions(): Promise<void> {
  if (!global.__pendingEmissions?.size) return
  await new Promise(resolve => {
    if (global.__pendingEmissions!.size === 0) {
      resolve(undefined)
    } else {
      global.__emissionsResolves!.add(resolve)
    }
  })
}

export { matchesQuery, service, sortRows } from '../lib/testing.js'
export type { TestItem } from '../lib/testing.js'

/**
 * The shared in-memory client (see `figbird/testing`), with mutation-triggered
 * realtime emissions routed through `queueTask` so `dom().flush()` can await them.
 */
export function mockFeathers(
  services: MockFeathersServices,
  options: Omit<MockFeathersOptions, 'schedule'> = {},
): MockFeathers {
  return baseMockFeathers(services, { ...options, schedule: queueTask })
}

/**
 * Standard app factory for hook tests: a mock Feathers client behind a
 * FeathersAdapter + Figbird (realtime batching disabled so events apply
 * immediately), wrapped in StrictMode + FigbirdProvider.
 *
 * Pass `queryAwareFind: true` to make every service's `find` honor filters.
 */
export function createTestApp<S extends Schema>(
  schema: S,
  services: MockFeathersServices,
  {
    queryAwareFind = false,
    skipTotal = false,
    operators,
    eventBatchInterval = 0,
  }: {
    queryAwareFind?: boolean
    skipTotal?: boolean
    operators?: Record<string, CustomOperatorRegistration>
    eventBatchInterval?: number
  } = {},
) {
  const feathers = mockFeathers(services, { queryAwareFind, skipTotal })

  const adapter = new FeathersAdapter(feathers, operators ? { operators } : {})
  const figbird = new Figbird({
    schema,
    adapter,
    eventBatchInterval,
    // Keep existing tests deterministic: no reconcile cooldown unless a test
    // opts in with its own instance.
    reconcileCooldown: 0,
    // Error-path tests opt into retry explicitly so they do not wait through
    // production backoff or change their expected request counts.
    retry: false,
  })

  // Pin the provider's generics — createElement can't infer them from the figbird prop.
  const Provider = FigbirdProvider<S, typeof adapter>
  function App({ children }: { children?: ReactNode }) {
    // No JSX in this .ts file, and the provider's props type requires children,
    // so it must travel via the props object.
    // oxlint-disable-next-line react/no-children-prop
    return createElement(StrictMode, null, createElement(Provider, { figbird, children }))
  }

  return { App, figbird, feathers, adapter }
}
