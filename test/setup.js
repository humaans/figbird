import { configure } from 'enzyme'
import Adapter from 'enzyme-adapter-react-16'
import { JSDOM } from 'jsdom'

process.env.NODE_ENV = 'test'

configure({ adapter: new Adapter() })

// setup jsdom
const dom = new JSDOM('<!doctype html><div id="root"></div>')
const { window } = dom

function copyProps(src, target) {
  Object.defineProperties(target, {
    ...Object.getOwnPropertyDescriptors(src),
    ...Object.getOwnPropertyDescriptors(target)
  })
}

global.window = window
global.document = window.document
global.navigator = {
  userAgent: 'node.js'
}
window.requestAnimationFrame = global.requestAnimationFrame = function(callback) {
  return setTimeout(callback, 0)
}
window.cancelAnimationFrame = global.cancelAnimationFrame = function(id) {
  clearTimeout(id)
}
copyProps(window, global)

const IGNORE_ERROR_REGEXES = [
  /Please pass in a feathers client/,
  /The above error occurred in the <Provider> component/
]

// eslint-disable-next-line no-console
const originalConsoleError = console.error.bind(console)
// eslint-disable-next-line no-console
console.error = (...args) => {
  const [firstArgument] = args
  if (
    typeof firstArgument === 'string' &&
    IGNORE_ERROR_REGEXES.some(regex => regex.test(firstArgument))
  ) {
    return
  }

  originalConsoleError(...args)
}
