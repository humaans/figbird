import util from 'util'
import { JSDOM } from 'jsdom'
import EventEmitter from 'events'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

export function dom() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>')
  global.window = dom.window
  const domNode = dom.window.document.getElementById('root')
  const root = createRoot(domNode)

  function onError(event) {
    // Note: this will swallow reports about unhandled errors!
    // Use with extreme caution.
    console.log(event)
    event.preventDefault()
  }
  dom.window.addEventListener('error', onError)

  function render(el) {
    act(() => {
      root.render(el)
    })
  }

  function unmount() {
    act(() => {
      root.unmount()
    })
  }

  function click(el) {
    act(() => {
      el.dispatchEvent(
        new dom.window.MouseEvent('click', {
          view: dom.window,
          bubbles: true,
          cancelable: true,
        })
      )
    })
  }

  function $(sel) {
    return dom.window.document.querySelector(sel)
  }

  function $all(sel) {
    return Array.from(dom.window.document.querySelectorAll(sel))
  }

  async function flush(fn) {
    await act(async () => {
      if (fn) {
        await fn()
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    })
  }

  return { root, render, unmount, click, flush, $, $all, act }
}

export const swallowErrors = yourTestFn => {
  const error = console.error
  console.error = () => {}
  yourTestFn()
  console.error = error
}

class Service {
  constructor(name, data) {
    this.name = name
    this.data = data
    this.counts = {
      get: 0,
      find: 0,
      create: 0,
      patch: 0,
      update: 0,
      remove: 0,
    }
    this.delay = 0
  }

  setDelay(delay) {
    this.delay = delay
  }

  get(id, params) {
    this.counts.get++
    return Promise.resolve(this.data[id])
  }

  async find(params = {}) {
    this.counts.find++
    const limit = (params.query && params.query.$limit) || 100
    const skip = (params.query && params.query.$skip) || 0
    const keys = Object.keys(this.data)
    const data = keys
      .slice(skip)
      .slice(0, limit)
      .map(id => this.data[id])

    if (this.delay) {
      await new Promise(resolve => setTimeout(resolve, this.delay))
    }

    return Promise.resolve({
      total: keys.length,
      limit,
      skip,
      data,
    })
  }

  create(data, params) {
    if (Array.isArray(data)) {
      this.counts.create += data.length
      const ids = data.map(datum => datum.id)
      this.data = { ...this.data }
      for (const datum of data) {
        this.data[datum.id] = { ...datum, updatedAt: datum.updatedAt || Date.now() }
        this.emit('created', this.data[datum.id])
      }
      return Promise.all(ids.map(id => this.get(id)))
    }
    this.counts.create++
    const { id } = data
    this.data = { ...this.data, [id]: { ...data, updatedAt: data.updatedAt || Date.now() } }
    this.emit('created', this.data[id])
    return this.get(id)
  }

  patch(id, data, params) {
    this.counts.patch++
    this.data = {
      ...this.data,
      [id]: { ...this.data[id], ...data, updatedAt: data.updatedAt || Date.now() },
    }
    this.emit('patched', this.data[id])
    return this.get(id)
  }

  update(id, data, params) {
    this.counts.update++
    this.data = { ...this.data, [id]: { ...data, updatedAt: data.updatedAt || Date.now() } }
    this.emit('updated', this.data[id])
    return this.get(id)
  }

  remove(id, params) {
    this.counts.remove++
    this.data = { ...this.data }
    const item = this.data[id]
    delete this.data[id]
    this.emit('removed', item)
    // TODO - check if feathers throws 404 in this case
    return Promise.resolve(item)
  }
}

util.inherits(Service, EventEmitter)

export function service(name, details) {
  return new Service(name, details.data)
}

export function mockFeathers(services) {
  services = Object.keys(services).reduce((acc, name) => {
    acc[name] = service(name, services[name])
    return acc
  }, {})

  const feathers = {
    service(name) {
      return services[name]
    },
  }

  return feathers
}

export async function flush(app) {
  const update = async () => {
    app.update()
  }

  // flush effects
  await act(update)
  // wait for data to be fetched and atom changes to propagate
  await new Promise(resolve => setTimeout(resolve, 20))
  // flush the atom state change effects
  await act(update)
}
