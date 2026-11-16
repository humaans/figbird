import { createSchema, service } from '../lib'
import { createTestApp } from './helpers'

export const schema = createSchema({
  services: {
    jobs: service<{
      item: { id: number; status: string }
      methods: {
        getCheck: (
          input: { id: number },
          extra?: unknown,
        ) => Promise<{ id: number; status: string }>
        count: () => Promise<number>
        empty: () => Promise<null>
        maybe: () => Promise<undefined>
      }
    }>().at('api/jobs'),
  },
})

export function app() {
  return createTestApp(schema, { 'api/jobs': { data: { 1: { id: 1, status: 'cached' } } } })
}
