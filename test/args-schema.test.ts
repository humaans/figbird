import test from 'ava'
import { FeathersAdapter } from '../lib/adapters/feathers'
import { defineQuery, Figbird, QueryArgsError, type StandardSchemaV1 } from '../lib/core/figbird'
import { createSchema, service } from '../lib/core/schema'
import { mockFeathers } from './helpers'

interface Issue {
  id: number
  title: string
  updatedAt?: number
}

const schema = createSchema({
  services: {
    issues: service<{ item: Issue }>(),
  },
})

function makeFigbird() {
  const feathers = mockFeathers({
    issues: {
      data: {
        1: { id: 1, title: 'first' },
        2: { id: 2, title: 'second' },
      },
    },
  })
  const adapter = new FeathersAdapter(feathers)
  return new Figbird({ schema, adapter })
}

// A tiny hand-rolled Standard Schema implementation. Not a real validator — it just
// proves figbird relies only on the `~standard` interface and not on any specific
// runtime library. Real consumers would pass zod/valibot/arktype/etc.
function objectSchema<T>(validators: {
  [K in keyof T]: (value: unknown, key: string) => T[K]
}): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test-inline',
      validate(input: unknown) {
        if (typeof input !== 'object' || input === null) {
          return { issues: [{ message: 'expected object', path: [] }] }
        }
        const issues: { message: string; path: PropertyKey[] }[] = []
        const out: Record<string, unknown> = {}
        for (const [key, run] of Object.entries(validators) as [
          string,
          (value: unknown, key: string) => unknown,
        ][]) {
          try {
            out[key] = run((input as Record<string, unknown>)[key], key)
          } catch (err) {
            issues.push({
              message: err instanceof Error ? err.message : String(err),
              path: [key],
            })
          }
        }
        if (issues.length > 0) return { issues }
        return { value: out as T }
      },
    },
  }
}

const positiveInt = (raw: unknown, key: string): number => {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw
  if (typeof raw === 'string') {
    const n = Number(raw)
    if (Number.isInteger(n) && n > 0) return n
  }
  throw new Error(`${key} must be a positive integer`)
}

test('defineQuery attaches a validate function', t => {
  const figbird = makeFigbird()
  const issueDetail = defineQuery('issueDetail', objectSchema({ id: positiveInt }), ({ id }) =>
    figbird.q.issues.get(id),
  )
  t.is(issueDetail.name, 'issueDetail')
  t.is(typeof issueDetail.build, 'function')
  t.is(typeof issueDetail.validate, 'function')
  t.deepEqual(issueDetail.validate({ id: 7 }), { id: 7 })
})

test('schema validation throws QueryArgsError on invalid args', t => {
  const figbird = makeFigbird()
  const issueDetail = defineQuery('issueDetail', objectSchema({ id: positiveInt }), ({ id }) =>
    figbird.q.issues.get(id),
  )
  const err = t.throws(() => issueDetail.validate({ id: 'abc' }), { instanceOf: QueryArgsError })
  t.is(err.queryName, 'issueDetail')
  t.true(err.message.includes('issueDetail'))
  t.true(err.message.includes('id'))
  t.is(err.issues.length, 1)
})

test('schema validation normalizes args before build', t => {
  const figbird = makeFigbird()
  const issueDetail = defineQuery('issueDetail', objectSchema({ id: positiveInt }), ({ id }) =>
    figbird.q.issues.get(id),
  )
  // Normalized: '7' string coerces to 7. Both produce the same builder hash.
  const fromString = issueDetail.build(issueDetail.validate({ id: '7' }))
  const fromNumber = issueDetail.build(issueDetail.validate({ id: 7 }))
  t.is(fromString.hash(), fromNumber.hash())
})

test('figbird.prepare runs schema validation and throws on invalid args', t => {
  const figbird = makeFigbird()
  const issueDetail = defineQuery('issueDetail', objectSchema({ id: positiveInt }), ({ id }) =>
    figbird.q.issues.get(id),
  )
  const err = t.throws(() => figbird.prepare(issueDetail, { id: -1 } as never), {
    instanceOf: QueryArgsError,
  })
  t.is(err.queryName, 'issueDetail')
})

test('figbird.prepare uses normalized args so prepared and direct calls share the cache key', t => {
  const figbird = makeFigbird()
  const issueDetail = defineQuery('issueDetail', objectSchema({ id: positiveInt }), ({ id }) =>
    figbird.q.issues.get(id),
  )
  const prepared = figbird.prepare(issueDetail, { id: '1' } as never)
  // The same cache entry is hit when args normalize to the same value.
  const directBuilder = issueDetail.build(issueDetail.validate({ id: 1 }))
  const directRef = figbird.relationalQuery(directBuilder)
  t.is(prepared.key, directRef.hash())
  prepared.release()
})

test('async-returning schema is rejected synchronously with QueryArgsError', t => {
  const asyncSchema: StandardSchemaV1<unknown, { id: number }> = {
    '~standard': {
      version: 1,
      vendor: 'test-async',
      validate: () => Promise.resolve({ value: { id: 1 } }),
    },
  }
  const figbird = makeFigbird()
  const def = defineQuery('asyncQuery', asyncSchema, ({ id }) => figbird.q.issues.get(id))
  const err = t.throws(() => def.validate({ id: 1 }), { instanceOf: QueryArgsError })
  t.is(err.queryName, 'asyncQuery')
  t.true(/synchronous/i.test(err.message))
})

test('QueryArgsError carries the validator-reported issues', t => {
  const figbird = makeFigbird()
  const def = defineQuery(
    'multi',
    objectSchema({
      id: positiveInt,
      // oxlint-disable-next-line @typescript-eslint/no-unused-vars
      kind: (raw: unknown) => {
        if (raw !== 'open' && raw !== 'closed') throw new Error('kind must be open|closed')
        return raw
      },
    }),
    ({ id }) => figbird.q.issues.get(id),
  )
  const err = t.throws(() => def.validate({ id: 'x', kind: 'wat' }), {
    instanceOf: QueryArgsError,
  })
  t.is(err.issues.length, 2)
  const messages = err.issues.map(i => i.message).join('|')
  t.true(/positive integer/.test(messages))
  t.true(/open\|closed/.test(messages))
})
