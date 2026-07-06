import { JSDOM } from 'jsdom'
import type { ReactElement, ReactNode } from 'react'
import { act, createElement, StrictMode } from 'react'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import {
  FeathersAdapter,
  Figbird,
  FigbirdProvider,
  type CustomOperator,
  type Schema,
} from '../lib/index.js'
import {
  installQueryAwareFind,
  mockFeathers as baseMockFeathers,
  type MockFeathers,
  type MockFeathersServices,
} from '../lib/testing.js'

// Local test type for Feathers items

interface DomHelpers {
  root: Root
  render: (el: ReactElement) => void
  unmount: () => void
  click: (el: Element) => void
  flush: (fn?: () => Promise<void> | void) => Promise<void>
  $: (sel: string) => Element | null
  $all: (sel: string) => Element[]
  act: typeof act
}

export function dom(): DomHelpers {
  const dom = new JSDOM('<!doctype html><div id="root"></div>')
  // JSDOM's DOMWindow interface doesn't perfectly match TypeScript's Window & typeof globalThis.
  // The double assertion pattern (as unknown as T) is the recommended approach when we need
  // to bridge incompatible types that we know are safe to use in our context.
  // This is necessary because JSDOM provides its own DOMWindow type that has slight differences
  // from the standard Window interface, but is functionally compatible for testing purposes.
  global.window = dom.window as unknown as Window & typeof globalThis
  const domNode = dom.window.document.getElementById('root')!
  const root = createRoot(domNode)

  function onError(event: Event): void {
    // Note: this will swallow reports about unhandled errors!
    // Use with extreme caution.
    console.log(event)
    event.preventDefault()
  }
  dom.window.addEventListener('error', onError)

  function render(el: ReactElement): void {
    act(() => {
      root.render(el)
    })
  }

  function unmount(): void {
    act(() => {
      root.unmount()
    })
  }

  function click(el: Element): void {
    act(() => {
      el.dispatchEvent(
        new dom.window.MouseEvent('click', {
          view: dom.window as unknown as Window,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
  }

  function $(sel: string): Element | null {
    return dom.window.document.querySelector(sel)
  }

  function $all(sel: string): Element[] {
    return Array.from(dom.window.document.querySelectorAll(sel))
  }

  async function flush(fn?: () => Promise<void> | void): Promise<void> {
    await act(async () => {
      if (fn) {
        await fn()
      }
      await waitForEmissions()
    })
  }

  return { root, render, unmount, click, flush, $, $all, act }
}

export const swallowErrors = (yourTestFn: () => void): void => {
  const error = console.error
  console.error = () => {}
  yourTestFn()
  console.error = error
}

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

async function waitForEmissions(): Promise<void> {
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
export { installQueryAwareFind }
export type { TestItem } from '../lib/testing.js'

/**
 * The shared in-memory client (see `figbird/testing`), with mutation-triggered
 * realtime emissions routed through `queueTask` so `dom().flush()` can await them.
 */
export function mockFeathers(services: MockFeathersServices): MockFeathers {
  return baseMockFeathers(services, { schedule: queueTask })
}

/**
 * Standard app factory for hook tests: a mock Feathers client behind a
 * FeathersAdapter + Figbird (realtime batching disabled so events apply
 * immediately), wrapped in StrictMode + FigbirdProvider.
 *
 * Pass `queryAwareFind: true` to install the filter-honoring `find` on every
 * service in the mock.
 */
export function createTestApp<S extends Schema>(
  schema: S,
  services: MockFeathersServices,
  {
    queryAwareFind = false,
    operators,
  }: { queryAwareFind?: boolean; operators?: Record<string, CustomOperator> } = {},
) {
  const serviceNames = Object.keys(services).filter(name => name !== 'skipTotal')
  const feathers = mockFeathers(services)
  if (queryAwareFind) installQueryAwareFind(feathers, serviceNames)

  const adapter = new FeathersAdapter(feathers, operators ? { operators } : {})
  const figbird = new Figbird({
    schema,
    adapter,
    eventBatchInterval: 0,
    // Keep existing tests deterministic: no reconcile cooldown unless a test
    // opts in with its own instance.
    reconcileCooldown: 0,
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
