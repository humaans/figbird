import util from 'util'
import { JSDOM } from 'jsdom'
import EventEmitter from 'events'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

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
        }),
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
      await waitForEmissions()
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
  constructor(name, data, options = {}) {
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
    this.options = options
  }

  setDelay(delay) {
    this.delay = delay
  }

  get(id) {
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

    return Promise.resolve(
      this.options.skipTotal
        ? {
            limit,
            skip,
            data,
          }
        : {
            total: keys.length,
            limit,
            skip,
            data,
          },
    )
  }

  create(data) {
    if (Array.isArray(data)) {
      this.counts.create += data.length
      const ids = data.map(datum => datum.id)
      this.data = { ...this.data }
      for (const datum of data) {
        this.data[datum.id] = { ...datum, updatedAt: datum.updatedAt || Date.now() }
        queueTask(() => this.emit('created', this.data[datum.id]))
      }
      return Promise.all(ids.map(id => this.get(id)))
    }
    this.counts.create++
    const { id } = data
    this.data = { ...this.data, [id]: { ...data, updatedAt: data.updatedAt || Date.now() } }
    const mutatedItem = this.data[id]
    queueTask(() => this.emit('created', mutatedItem))
    return this.get(id)
  }

  patch(id, data) {
    this.counts.patch++
    this.data = {
      ...this.data,
      [id]: { ...this.data[id], ...data, updatedAt: data.updatedAt || Date.now() },
    }
    const mutatedItem = this.data[id]
    queueTask(() => this.emit('patched', mutatedItem))
    return this.get(id)
  }

  update(id, data) {
    this.counts.update++
    this.data = { ...this.data, [id]: { ...data, updatedAt: data.updatedAt || Date.now() } }
    const mutatedItem = this.data[id]
    queueTask(() => this.emit('updated', mutatedItem))
    return this.get(id)
  }

  remove(id) {
    this.counts.remove++
    this.data = { ...this.data }
    const mutatedItem = this.data[id]
    delete this.data[id]
    queueTask(() => this.emit('removed', mutatedItem))
    // TODO - check if feathers throws 404 in this case
    return Promise.resolve(mutatedItem)
  }
}

util.inherits(Service, EventEmitter)

export function queueTask(task) {
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

    global.__pendingEmissions.delete(emissionId)
    if (global.__pendingEmissions.size === 0 && global.__emissionsResolves.size > 0) {
      global.__emissionsResolves.forEach(resolve => resolve())
      global.__emissionsResolves.clear()
    }
  }, 1)
}

async function waitForEmissions() {
  if (!global.__pendingEmissions?.size) return
  await new Promise(resolve => {
    if (global.__pendingEmissions.size === 0) {
      resolve()
    } else {
      global.__emissionsResolves.add(resolve)
    }
  })
}

export function service(name, details, options) {
  return new Service(name, details.data, options)
}

export function mockFeathers(services) {
  const skipTotal = !!services.skipTotal
  delete services.skipTotal

  services = Object.keys(services).reduce((acc, name) => {
    acc[name] = service(name, services[name], { skipTotal })
    return acc
  }, {})

  const feathers = {
    service(name) {
      return services[name]
    },
  }

  return feathers
}
