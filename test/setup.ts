import { JSDOM } from 'jsdom'

// React DOM detects input-event support when imported, before individual tests render.
const initialDom = new JSDOM('<!doctype html><html><body></body></html>')
global.window = initialDom.window as unknown as Window & typeof globalThis
global.document = initialDom.window.document

// Extend the global namespace to include IS_REACT_ACT_ENVIRONMENT
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

global.IS_REACT_ACT_ENVIRONMENT = true
