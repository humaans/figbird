import test from 'ava'
import { createHooks, createSchema, query, service } from '../lib'

const declaration = () =>
  service<{ item: { id: number }; methods: { retry: (id: number) => Promise<void> } }>()

test('service queries are declared once with runtime names and preserve either chaining order', t => {
  const reads = {
    getCheck: query<(id: number) => Promise<{ progress: number }>>(),
    count: query<() => Promise<number>>(),
  }
  const schema = createSchema({
    services: {
      jobs: declaration().at('api/jobs').queries(reads),
      other: declaration().queries(reads).at('api/other'),
    },
  })
  t.deepEqual(Object.keys(schema.services.jobs.queryMethods), ['getCheck', 'count'])
  t.is(schema.services.jobs.path, 'api/jobs')
  t.is(schema.services.other.path, 'api/other')
  t.true(Object.isFrozen(schema.services.jobs.queryMethods))
  const { q } = createHooks(schema)
  t.is(q.jobs.getCheck(1).method, 'getCheck')
  t.is(q.jobs.count().method, 'count')
  const untyped = q('jobs' as string) as unknown as Record<string, (input: unknown) => unknown>
  t.throws(() => untyped.wehre!({ id: 1 }), { instanceOf: TypeError })
  t.is(Reflect.get(q.jobs, 'retry'), undefined)
})

test('createSchema rejects query names that collide with builder and protocol members', t => {
  for (const name of [
    'get',
    'all',
    'where',
    'limit',
    'skip',
    'hash',
    'toAST',
    'server',
    'snapshot',
    'paginate',
    'related',
    'then',
    'toJSON',
    'toString',
  ]) {
    t.throws(
      () =>
        createSchema({
          services: { jobs: declaration().queries({ [name]: query<() => Promise<number>>() }) },
        }),
      { instanceOf: TypeError, message: /reserved/ },
    )
  }
})

test('createSchema rejects malformed JavaScript query declarations', t => {
  const bad = declaration().queries({ broken: {} as ReturnType<typeof query> })
  t.throws(() => createSchema({ services: { jobs: bad } }), { message: /query<F>/ })
})
