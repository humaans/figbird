import util from 'util'
import EventEmitter from 'events'
import { act } from 'react-dom/test-utils'

class Service {
  constructor(name, data) {
    this.name = name
    this.data = data
  }

  get(id, params) {
    return Promise.resolve(this.data[id])
  }

  find(params) {
    const data = Object.keys(this.data).map(id => this.data[id])
    return Promise.resolve({
      total: data.length,
      limit: 100,
      skip: 0,
      data
    })
  }

  create(data, params) {
    const { id } = data
    this.data = { ...this.data, [id]: data }
    this.emit('created', this.data[id])
    return this.get(id)
  }

  patch(id, data, params) {
    this.data = { ...this.data, [id]: { ...this.data[id], ...data } }
    this.emit('patched', this.data[id])
    return this.get(id)
  }

  update(id, data, params) {
    this.data = { ...this.data, [id]: { ...data } }
    this.emit('updated', this.data[id])
    return this.get(id)
  }

  remove(id, params) {
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
    }
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
