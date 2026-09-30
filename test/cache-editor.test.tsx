import { createCollector } from '../lib/devtools/collector.js'
import { FigbirdDevtoolsPanel } from '../lib/devtools/Devtools.js'
import { dom, it } from './dom.js'
import { createTestApp } from './helpers.js'
import { schema, services } from './mutation-test-helpers.js'

it('cache editor validates IDs, updates query membership, and undoes edits without server writes', async t => {
  const { figbird, feathers } = createTestApp(schema, services(), { queryAwareFind: true })
  const { render, unmount, click, input, flush, $, $all } = dom()
  t.teardown(() => {
    unmount()
    figbird.dispose()
  })
  const list = figbird.query(figbird.q.notes)
  const detail = figbird.query(figbird.q.notes.get(1))
  const filtered = figbird.query(figbird.q.notes.where({ content: 'hello' }))
  for (const query of [list, detail, filtered]) t.teardown(query.subscribe(() => {}))
  await Promise.all([list.suspensePromise(), detail.suspensePromise(), filtered.suspensePromise()])
  const counts = { ...feathers.service('notes').counts }
  const collector = createCollector(figbird, { heartbeatMs: 0 })
  const editor = {
    update: async (serviceName: string, itemId: string | number, item: unknown) =>
      figbird.editCacheEntity(serviceName, itemId, item),
  }
  const button = (label: string) => $all('button').find(el => el.textContent === label)!

  render(<FigbirdDevtoolsPanel collector={collector} cacheEditor={editor} />)
  click(button('cache'))
  t.is($all('tbody tr[tabindex]').length, 2)
  click($all('tbody tr[tabindex]').find(row => row.textContent?.includes('hello'))!)
  click(button('Edit cache'))

  input($('textarea')!, JSON.stringify({ id: 2, content: 'edited' }))
  await flush(() => click(button('Apply in memory')))
  t.true($('body')?.textContent?.includes('Edited JSON must retain the entity ID'))
  t.is(detail.getSnapshot().data?.content, 'hello')
  t.is(filtered.getSnapshot().data?.length, 1)
  t.truthy($('textarea'), 'a rejected edit stays open for correction')

  input($('textarea')!, JSON.stringify({ id: 1, content: 'edited' }))
  await flush(() => click(button('Apply in memory')))
  t.is(detail.getSnapshot().data?.content, 'edited')
  t.is(list.getSnapshot().data?.find(note => note.id === 1)?.content, 'edited')
  t.deepEqual(filtered.getSnapshot().data, [])
  t.true($('body')?.textContent?.includes('Applied in memory. No server request was sent.'))
  t.is($('textarea'), null)
  t.is(collector.getSnapshot().cache?.[0]?.entities[0]?.lastChange?.source, 'devtools')

  await flush(() => click(button('Undo')))
  t.is(detail.getSnapshot().data?.content, 'hello')
  t.is(list.getSnapshot().data?.find(note => note.id === 1)?.content, 'hello')
  t.deepEqual(
    filtered.getSnapshot().data?.map(note => note.id),
    [1],
  )
  t.false($all('button').some(el => el.textContent === 'Undo'))
  t.deepEqual(feathers.service('notes').counts, counts, 'edits and undo send no requests')
  t.is(feathers.service('notes').data[1]?.content, 'hello')
})
