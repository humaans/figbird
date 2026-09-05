import ava from 'ava'
import { JSDOM } from 'jsdom'
import { act, type ReactElement } from 'react'
import { createRoot, type Root, type RootOptions } from 'react-dom/client'
import { waitForEmissions } from './helpers.js'

// React's act queue and global.window are shared within a worker. Files remain parallel.
export const it = ava.serial

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

export function dom(options?: RootOptions): DomHelpers {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://figbird.test' })
  // JSDOM's DOMWindow interface doesn't perfectly match TypeScript's Window & typeof globalThis.
  // The double assertion pattern (as unknown as T) is the recommended approach when we need
  // to bridge incompatible types that we know are safe to use in our context.
  // This is necessary because JSDOM provides its own DOMWindow type that has slight differences
  // from the standard Window interface, but is functionally compatible for testing purposes.
  global.window = dom.window as unknown as Window & typeof globalThis
  const domNode = dom.window.document.getElementById('root')!
  const root = createRoot(domNode, options)

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
