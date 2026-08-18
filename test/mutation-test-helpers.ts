import type { FigbirdEvent } from '../lib'
import { createSchema, service } from '../lib'

export interface Note {
  id: number
  content: string
  parentId?: number
  updatedAt?: number
}

/** The mock service's methods return the helpers' loose TestItem shape. */
export type MockItem = Note & { [key: string]: unknown }

export interface ArchiveResult {
  id: number
  archived: boolean
  reason: string
}

interface NoteService {
  item: Note
  methods: {
    archive: (id: number, reason: string) => Promise<ArchiveResult>
  }
}

export const schema = createSchema({
  services: {
    notes: service<NoteService>(),
    people: service<{ item: { id: number; name: string } }, 'api/people'>({
      path: 'api/people',
    }),
  },
})

// The mock feathers client keys services by transport path, not schema key.
export const services = () => ({
  notes: { data: { 1: { id: 1, content: 'hello' }, 2: { id: 2, content: 'world' } } },
  'api/people': { data: { 1: { id: 1, name: 'Ada' } } },
})

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function collectEvents(
  figbird: { events: { subscribe: (fn: (e: FigbirdEvent) => void) => () => void } },
  prefix: string,
) {
  const events: FigbirdEvent[] = []
  figbird.events.subscribe(event => {
    if (event.kind.startsWith(prefix)) events.push(event)
  })
  return events
}
