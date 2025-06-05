export function dom(): {
  root: HTMLElement
  render: (el: React.ReactElement) => void
  unmount: () => void
  click: (el: HTMLElement) => void
  flush: (fn: () => void | Promise<void>) => Promise<void>
  $: (sel: string) => HTMLElement | null
  $all: (sel: string) => HTMLElement[]
  act: (fn: () => void | Promise<void>) => Promise<void>
}
export function queueTask(task: () => void): void
export function service(
  name: string,
  details: Record<string, unknown>[],
  options?: Record<string, unknown>,
): Service
export function mockFeathers(services: Record<string, Service>): {
  service(name: string): Service
}
export function swallowErrors(yourTestFn: () => void | Promise<void>): void
declare class Service {
  constructor(name: string, data: Record<string, unknown>[], options?: Record<string, unknown>)
  name: string
  data: Record<string, unknown>[]
  counts: {
    get: number
    find: number
    create: number
    patch: number
    update: number
    remove: number
  }
  delay: number
  options: Record<string, unknown>
  setDelay(delay: number): void
  get(id: string | number): Promise<Record<string, unknown>>
  find(params?: Record<string, unknown>): Promise<
    | {
        limit: number
        skip: number
        data: Record<string, unknown>[]
        total?: undefined
      }
    | {
        total: number
        limit: number
        skip: number
        data: Record<string, unknown>[]
      }
  >
  create(data: Record<string, unknown>): Promise<Record<string, unknown>>
  patch(id: string | number, data: Record<string, unknown>): Promise<Record<string, unknown>>
  update(id: string | number, data: Record<string, unknown>): Promise<Record<string, unknown>>
  remove(id: string | number): Promise<Record<string, unknown>>
}
export {}
//# sourceMappingURL=helpers.d.ts.map
