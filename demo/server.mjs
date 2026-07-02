/**
 * Tiny Feathers server for the figbird demo.
 *
 * Exposes services over Socket.IO: issues, comments, users, teams, labels,
 * issue-label joins, reactions, companies, people.
 *
 * Deliberately simulates real-world conditions:
 *   - Each service has its own per-operation latency range (min..max ms). Comments
 *     are the slow path so switching issues reliably crosses figbird's 400ms delayed-
 *     spinner threshold. Users are snappy so creators/authors come in first.
 *   - A background ticker periodically creates a new comment (and reaction) so clients
 *     can observe realtime events flowing into active queries. The ticker is OFF by
 *     default — flip it on from the dev-tools panel when you want to watch realtime
 *     events flow. Defaulting it off keeps the event log clean while you debug.
 *
 * Plus a control surface at `_demo` for the UI:
 *   - find()  → { backgroundEnabled }
 *   - patch() → toggle flags
 *   - create({ action: 'reset' }) → re-seed the stores back to the initial state
 *
 * CORS / auth: this is a local demo — none.
 */

import { feathers } from '@feathersjs/feathers'
import socketio from '@feathersjs/socketio'
import { MemoryService } from '@feathersjs/memory'

const BACKGROUND_TICK_MS = 6000 // every 6s a random comment appears

const sleep = ms => new Promise(r => setTimeout(r, ms))
const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1))

class SlowMemoryService extends MemoryService {
  constructor(opts, { minLatency, maxLatency }) {
    super(opts)
    this._minLatency = minLatency
    this._maxLatency = maxLatency
  }
  async _tick() {
    await sleep(rand(this._minLatency, this._maxLatency))
  }
  async find(params) {
    await this._tick()
    return super.find(params)
  }
  async get(id, params) {
    await this._tick()
    return super.get(id, params)
  }
  async create(data, params) {
    await this._tick()
    return super.create(data, params)
  }
  async patch(id, data, params) {
    await this._tick()
    return super.patch(id, data, params)
  }
  async remove(id, params) {
    await this._tick()
    return super.remove(id, params)
  }
}

const app = feathers()

app.configure(
  socketio({
    cors: { origin: '*' },
  }),
)

app.on('connection', connection => {
  app.channel('anonymous').join(connection)
})

app.publish(() => app.channel('anonymous'))

// ----- Seed services -----

// Per-service latency profile — tuned so the common product interactions map cleanly
// onto the "delayed spinner" UX pattern:
//
//   - users/teams/labels (100–300ms): snappy; relation leaves pop in first.
//   - joins/reactions    (200–500ms): usually below the spinner threshold.
//   - issues             (300–700ms): straddles the threshold.
//   - comments           (700–1300ms): reliably slow; selecting a different issue waits on this
//                 so the delayed spinner gets to show its work. On warm-cache revisits
//                 the data comes from QueryStore instantly and the spinner stays silent.
const users = new SlowMemoryService(
  { multi: false, paginate: false },
  { minLatency: 100, maxLatency: 300 },
)
const teams = new SlowMemoryService(
  { multi: false, paginate: false },
  { minLatency: 100, maxLatency: 300 },
)
const issues = new SlowMemoryService(
  { multi: false, paginate: { default: 50, max: 200 } },
  { minLatency: 300, maxLatency: 700 },
)
const comments = new SlowMemoryService(
  { multi: false, paginate: { default: 50, max: 500 } },
  { minLatency: 700, maxLatency: 1300 },
)
const labels = new SlowMemoryService(
  { multi: false, paginate: false },
  { minLatency: 100, maxLatency: 300 },
)
const issueLabels = new SlowMemoryService(
  { multi: false, paginate: { default: 50, max: 500 } },
  { minLatency: 200, maxLatency: 500 },
)
const reactions = new SlowMemoryService(
  { multi: false, paginate: { default: 50, max: 500 } },
  { minLatency: 200, maxLatency: 500 },
)
const companies = new SlowMemoryService(
  { multi: false, paginate: false },
  { minLatency: 150, maxLatency: 350 },
)
const people = new SlowMemoryService(
  { multi: false, paginate: { default: 50, max: 500 } },
  { minLatency: 300, maxLatency: 650 },
)
const orgUnits = new SlowMemoryService(
  { multi: false, paginate: false },
  { minLatency: 120, maxLatency: 280 },
)
const documents = new SlowMemoryService(
  { multi: false, paginate: { default: 50, max: 500 } },
  { minLatency: 300, maxLatency: 650 },
)

app.use('users', users)
app.use('teams', teams)
app.use('issues', issues)
app.use('comments', comments)
app.use('labels', labels)
app.use('issueLabels', issueLabels)
app.use('reactions', reactions)
app.use('companies', companies)
app.use('people', people)
app.use('orgUnits', orgUnits)
app.use('documents', documents)

const allServices = [
  users,
  teams,
  issues,
  comments,
  labels,
  issueLabels,
  reactions,
  companies,
  people,
  orgUnits,
  documents,
]

const clearStores = () => {
  for (const svc of allServices) {
    for (const key of Object.keys(svc.store)) {
      delete svc.store[key]
    }
  }
}

// Seed data directly via the store (bypassing latency, internal bootstrap)
const seed = async () => {
  for (const u of [
    { id: 1, name: 'Alice', avatar: '🌸' },
    { id: 2, name: 'Bob', avatar: '🐻' },
    { id: 3, name: 'Carol', avatar: '🎨' },
    { id: 4, name: 'Dina', avatar: '🦊' },
  ]) {
    users.store[u.id] = u
  }
  for (const t of [
    { id: 1, name: 'Core UI', accent: '#f97316' },
    { id: 2, name: 'Platform', accent: '#0ea5e9' },
    { id: 3, name: 'Data Experience', accent: '#10b981' },
  ]) {
    teams.store[t.id] = t
  }
  for (const i of [
    {
      id: 1,
      title: 'Hover state on primary button is off',
      status: 'open',
      creatorId: 1,
      assigneeId: 2,
      teamId: 1,
      priorityScore: 74,
      updatedAt: '2026-04-25T09:12:00.000Z',
    },
    {
      id: 2,
      title: 'API returns 500 on /search with empty q',
      status: 'open',
      creatorId: 2,
      assigneeId: 1,
      teamId: 2,
      priorityScore: 88,
      updatedAt: '2026-04-25T09:24:00.000Z',
    },
    {
      id: 3,
      title: 'Keyboard shortcut opens wrong panel',
      status: 'open',
      creatorId: 3,
      assigneeId: 4,
      teamId: 1,
      priorityScore: 61,
      updatedAt: '2026-04-25T09:40:00.000Z',
    },
    {
      id: 4,
      title: 'Settings page does not remember tab',
      status: 'closed',
      creatorId: 1,
      assigneeId: 3,
      teamId: 3,
      priorityScore: 22,
      updatedAt: '2026-04-25T08:05:00.000Z',
    },
    {
      id: 5,
      title: 'Payroll export drops custom fields',
      status: 'open',
      creatorId: 4,
      assigneeId: 3,
      teamId: 3,
      priorityScore: 45,
      updatedAt: '2026-04-25T07:31:00.000Z',
    },
    {
      id: 6,
      title: 'Hidden priority candidate for window refill',
      status: 'open',
      creatorId: 2,
      assigneeId: 4,
      teamId: 2,
      priorityScore: 12,
      updatedAt: '2026-04-25T07:02:00.000Z',
    },
  ]) {
    issues.store[i.id] = i
  }
  for (const l of [
    { id: 1, name: 'bug', tone: 'red' },
    { id: 2, name: 'frontend', tone: 'orange' },
    { id: 3, name: 'backend', tone: 'blue' },
    { id: 4, name: 'customer-impact', tone: 'green' },
    { id: 5, name: 'regression', tone: 'slate' },
  ]) {
    labels.store[l.id] = l
  }
  for (const link of [
    { id: 1, issueId: 1, labelId: 1 },
    { id: 2, issueId: 1, labelId: 2 },
    { id: 3, issueId: 2, labelId: 1 },
    { id: 4, issueId: 2, labelId: 3 },
    { id: 5, issueId: 3, labelId: 2 },
    { id: 6, issueId: 5, labelId: 4 },
  ]) {
    issueLabels.store[link.id] = link
  }
  for (const c of [
    { id: 1, issueId: 1, authorId: 2, body: 'Confirmed on Safari. Chrome looks fine.' },
    { id: 2, issueId: 1, authorId: 3, body: 'Might be the :hover rule ordering.' },
    { id: 3, issueId: 2, authorId: 1, body: 'Stack trace points at the query builder.' },
    { id: 4, issueId: 3, authorId: 2, body: 'Repros 100% with a US keyboard layout.' },
  ]) {
    comments.store[c.id] = c
  }
  for (const r of [
    { id: 1, commentId: 1, userId: 1, emoji: '👀' },
    { id: 2, commentId: 1, userId: 3, emoji: '🤔' },
    { id: 3, commentId: 2, userId: 1, emoji: '👍' },
  ]) {
    reactions.store[r.id] = r
  }
  for (const c of [
    { id: 1, name: 'Acme', segment: 'Mid-market' },
    { id: 2, name: 'Globex', segment: 'Enterprise' },
    { id: 3, name: 'Umbrella', segment: 'SMB' },
  ]) {
    companies.store[c.id] = c
  }
  for (const unit of [
    { id: 1, label: 'Engineering', color: '#2563eb' },
    { id: 2, label: 'People', color: '#16a34a' },
    { id: 3, label: 'Operations', color: '#9333ea' },
  ]) {
    orgUnits.store[unit.id] = unit
  }
  for (const p of [
    {
      id: 1,
      companyId: 1,
      orgUnitId: 2,
      name: 'Alice',
      status: 'active',
      startDate: '2025-05-01',
      role: 'People lead',
    },
    {
      id: 2,
      companyId: 1,
      orgUnitId: 1,
      name: 'Bob',
      status: 'active',
      startDate: '2025-04-15',
      role: 'Engineering manager',
    },
    {
      id: 3,
      companyId: 1,
      orgUnitId: 1,
      name: 'Cara',
      status: 'active',
      startDate: '2025-03-20',
      role: 'Product manager',
    },
    {
      id: 4,
      companyId: 1,
      orgUnitId: 3,
      name: 'Drew',
      status: 'inactive',
      startDate: '2025-06-01',
      role: 'Advisor',
    },
    {
      id: 5,
      companyId: 2,
      orgUnitId: 3,
      name: 'Eve',
      status: 'active',
      startDate: '2025-05-01',
      role: 'Finance lead',
    },
    {
      id: 6,
      companyId: 2,
      orgUnitId: 2,
      name: 'Finn',
      status: 'active',
      startDate: '2025-04-15',
      role: 'Talent partner',
    },
    {
      id: 7,
      companyId: 2,
      orgUnitId: 1,
      name: 'Gia',
      status: 'active',
      startDate: '2025-01-01',
      role: 'Operations analyst',
    },
    {
      id: 8,
      companyId: 3,
      orgUnitId: 3,
      name: 'Hana',
      status: 'active',
      startDate: '2025-03-10',
      role: 'Founder',
    },
    {
      id: 9,
      companyId: 3,
      orgUnitId: 1,
      name: 'Ivo',
      status: 'active',
      startDate: '2025-02-10',
      role: 'Designer',
    },
    {
      id: 10,
      companyId: 3,
      orgUnitId: 1,
      name: 'Jules',
      status: 'active',
      startDate: '2024-12-12',
      role: 'Engineer',
    },
  ]) {
    people.store[p.id] = p
  }
  for (const doc of [
    {
      id: 1,
      title: 'Search ranking plan',
      personId: 2,
      status: 'draft',
      createdAt: '2026-04-26T09:00:00.000Z',
    },
    {
      id: 2,
      title: 'Benefits rollout brief',
      personId: 1,
      status: 'published',
      createdAt: '2026-04-26T09:10:00.000Z',
    },
    {
      id: 3,
      title: 'Data export runbook',
      personId: 7,
      status: 'draft',
      createdAt: '2026-04-26T09:20:00.000Z',
    },
    {
      id: 4,
      title: 'Office move checklist',
      personId: 8,
      status: 'published',
      createdAt: '2026-04-26T09:30:00.000Z',
    },
  ]) {
    documents.store[doc.id] = doc
  }
}

await seed()

// ----- Background traffic simulator -----

const sampleBodies = [
  'Looks good to me 👍',
  "I can't reproduce this on Firefox latest.",
  'Just saw this happen again on staging.',
  'Might be related to the batching change from last week.',
  'Patched a hotfix locally — will send a PR.',
  'Logged timings — the call is ~700ms on the slow path.',
  'Adding a test for this.',
]

let nextCommentId = 5
let nextIssueId = 7
let nextIssueLabelId = 7
let nextReactionId = 4
let nextDocumentId = 5

const initialIdState = {
  nextCommentId,
  nextIssueId,
  nextIssueLabelId,
  nextReactionId,
  nextDocumentId,
}

const resetIdCounters = () => {
  nextCommentId = initialIdState.nextCommentId
  nextIssueId = initialIdState.nextIssueId
  nextIssueLabelId = initialIdState.nextIssueLabelId
  nextReactionId = initialIdState.nextReactionId
  nextDocumentId = initialIdState.nextDocumentId
}

// Background traffic is OFF by default. The dev-tools toggle flips this. Keeping it off
// by default makes the event timeline a clean signal of the user's actions.
let backgroundEnabled = false

app.use('_demo', {
  async find() {
    return { backgroundEnabled }
  },
  async patch(_id, data) {
    if (data && typeof data === 'object' && 'backgroundEnabled' in data) {
      backgroundEnabled = !!data.backgroundEnabled
    }
    return { backgroundEnabled }
  },
  async create(data) {
    if (data?.action === 'reset') {
      clearStores()
      resetIdCounters()
      await seed()
      return { ok: true, backgroundEnabled }
    }
    return { ok: false }
  },
})

// Don't broadcast _demo events — they're plumbing, not domain data.
app.service('_demo').publish(() => null)

const compare = (actual, expected) => {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('$in' in expected) return expected.$in.includes(actual)
    if ('$ne' in expected) return actual !== expected.$ne
  }
  return actual === expected
}

const applyFindWindow = (rows, query, defaultLimit = 50) => {
  const rest = { ...query }
  const $skip = rest.$skip ?? 0
  const $limit = rest.$limit ?? defaultLimit
  const $sort = rest.$sort
  delete rest.$skip
  delete rest.$limit
  delete rest.$sort

  let filtered = rows.filter(row =>
    Object.entries(rest).every(([key, value]) => {
      if (key.startsWith('$')) return true
      return compare(row[key], value)
    }),
  )

  if ($sort && typeof $sort === 'object') {
    const sortEntries = Object.entries($sort)
    filtered = filtered.slice().sort((a, b) => {
      for (const [field, dir] of sortEntries) {
        if (a[field] === b[field]) continue
        return (a[field] > b[field] ? 1 : -1) * (dir === -1 ? -1 : 1)
      }
      return 0
    })
  }

  return {
    total: filtered.length,
    limit: $limit,
    skip: $skip,
    data: filtered.slice($skip, $skip + $limit),
  }
}

app.service('issues').hooks({
  before: {
    find: [
      // Translate `query.title.$regex` (sent by figbird's server-authoritative search)
      // into in-memory filtering. The MemoryService doesn't understand $regex, so we
      // pull all rows, filter, then re-page. This mirrors what a real backend would
      // do via SQL ILIKE / full-text, but transparent for the demo.
      async context => {
        const q = context.params?.query
        const rx = q?.title?.$regex
        if (!rx) return context
        const re = new RegExp(rx, q.title.$options || 'i')
        const rest = { ...q }
        delete rest.title
        const $skip = rest.$skip ?? 0
        const $limit = rest.$limit ?? 50
        delete rest.$skip
        delete rest.$limit
        const baseQuery = {
          ...rest,
          $sort: rest.$sort,
          $limit: 200,
        }
        const { data: pre } = await issues.find({
          paginate: { default: 200, max: 200 },
          query: baseQuery,
        })
        const filtered = pre.filter(i => re.test(i.title))
        context.result = {
          total: filtered.length,
          limit: $limit,
          skip: $skip,
          data: filtered.slice($skip, $skip + $limit),
        }
        return context
      },
    ],
    create: [
      async context => {
        context.data = {
          ...context.data,
          id: context.data.id ?? nextIssueId++,
          updatedAt: context.data.updatedAt ?? new Date().toISOString(),
        }
        return context
      },
    ],
    patch: [
      async context => {
        context.data = {
          ...context.data,
          updatedAt: new Date().toISOString(),
        }
        return context
      },
    ],
  },
})

app.service('documents').hooks({
  before: {
    find: [
      async context => {
        const q = context.params?.query
        const orgUnitLabel = q?.['person.orgUnit.label']
        if (!orgUnitLabel) return context

        const rest = { ...q }
        delete rest['person.orgUnit.label']

        const rows = Object.values(documents.store).filter(doc => {
          const person = people.store[doc.personId]
          const unit = person ? orgUnits.store[person.orgUnitId] : null
          return unit ? compare(unit.label, orgUnitLabel) : false
        })

        context.result = applyFindWindow(rows, rest)
        return context
      },
    ],
    create: [
      async context => {
        context.data = {
          ...context.data,
          id: context.data.id ?? nextDocumentId++,
          createdAt: context.data.createdAt ?? new Date().toISOString(),
        }
        return context
      },
    ],
  },
})

app.service('issueLabels').hooks({
  before: {
    create: [
      async context => {
        context.data = {
          ...context.data,
          id: context.data.id ?? nextIssueLabelId++,
        }
        return context
      },
    ],
  },
})

setInterval(async () => {
  if (!backgroundEnabled) return
  const issueIds = Object.keys(issues.store).map(Number)
  const userIds = Object.keys(users.store).map(Number)
  if (issueIds.length === 0 || userIds.length === 0) return

  const issueId = issueIds[rand(0, issueIds.length - 1)]
  const authorId = userIds[rand(0, userIds.length - 1)]
  const body = sampleBodies[rand(0, sampleBodies.length - 1)]

  // Go through app.service so the 'created' event flows through the publish
  // pipeline and reaches socket subscribers. Calling the bare service ref
  // writes to the store but skips broadcast.
  await app.service('comments').create({
    id: nextCommentId++,
    issueId,
    authorId,
    body,
  })
}, BACKGROUND_TICK_MS)

// Occasionally drop a reaction too, just to exercise nested-relation realtime.
setInterval(async () => {
  if (!backgroundEnabled) return
  const commentIds = Object.keys(comments.store).map(Number)
  const userIds = Object.keys(users.store).map(Number)
  if (commentIds.length === 0) return
  const emojis = ['🚀', '💯', '🔥', '✨', '👏', '🎯']

  await app.service('reactions').create({
    id: nextReactionId++,
    commentId: commentIds[rand(0, commentIds.length - 1)],
    userId: userIds[rand(0, userIds.length - 1)],
    emoji: emojis[rand(0, emojis.length - 1)],
  })
}, BACKGROUND_TICK_MS * 1.5)

// Nudge an issue's score so the server-window panel visibly refills over time.
setInterval(async () => {
  if (!backgroundEnabled) return
  const openIssues = Object.values(issues.store).filter(issue => issue.status === 'open')
  if (openIssues.length === 0) return
  const issue = openIssues[rand(0, openIssues.length - 1)]

  await app.service('issues').patch(issue.id, {
    priorityScore: Math.min(99, issue.priorityScore + rand(1, 8)),
  })
}, BACKGROUND_TICK_MS * 2)

// ----- Start -----

const PORT = Number(process.env.PORT) || 3030

app.listen(PORT).then(() => {
  console.log(`[figbird-demo] server listening on http://localhost:${PORT}`)
  console.log(
    `[figbird-demo] per-service latency — users/teams/labels 100-300, joins/reactions 200-500, ` +
      `issues 300-700, comments 700-1300 ms.`,
  )
  console.log(
    `[figbird-demo] background traffic OFF by default (toggle via dev tools). ` +
      `When on, ticks every ${BACKGROUND_TICK_MS}ms.`,
  )
})
