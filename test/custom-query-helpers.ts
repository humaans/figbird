import { createSchema, service, query } from '../lib'
import { createTestApp } from './helpers'

export const schema = createSchema({
  services: {
    jobs: service<{
      item: { id: number; status: string }
      methods: { retry: (id: number) => Promise<{ id: number; status: string }> }
    }>()
      .at('api/jobs')
      .queries({
        getCheck:
          query<
            (input: { id: number }, extra?: unknown) => Promise<{ id: number; status: string }>
          >(),
        count: query<() => Promise<number>>(),
        empty: query<() => Promise<null>>(),
        maybe: query<() => Promise<undefined>>(),
      }),
  },
})

export function app() {
  return createTestApp(schema, { 'api/jobs': { data: { 1: { id: 1, status: 'cached' } } } })
}
