/**
 * Tiny Feathers server for the figbird demo.
 *
 * Exposes services over Socket.IO: issues, tasks, comments, users, teams,
 * labels, issue-label joins, reactions.
 *
 * Simulated conditions are a *dial*, not a tax:
 *   - Network latency has three profiles — fast (default, LAN-ish), realistic
 *     (median broadband API), slow (bad hotel wifi). The dev-tools drawer switches
 *     them live via the `_demo` control service. Fast is the default so the first
 *     impression is figbird's warm-cache/optimistic speed; drag to slow to watch
 *     SWR keep-previous-data and delayed spinners degrade gracefully.
 *   - A "simulated teammate" ticks every few seconds: comments, reactions,
 *     priority nudges, the occasional close/reopen. ON by default — realtime is
 *     the product. Toggle it off from dev tools when you want a quiet event log.
 *
 * Server-maintained state worth noticing:
 *   - `issue.commentIds` is a server-maintained id list (updated when comments are
 *     created), so list screens can render comment counts without fetching any
 *     comments — the "embed" pattern from DESIGN.md.
 *   - `assignee.teamId` dotted-path filters on `issues.find` are resolved server-side
 *     with a join, the contract relational filters require.
 *
 * Control surface at `_demo`:
 *   - find()  → { backgroundEnabled, latency }
 *   - patch(null, { backgroundEnabled?, latency? }) → update flags
 *   - create({ action: 'reset' }) → re-seed the stores back to the initial state
 *
 * CORS / auth: this is a local demo — none.
 */

import { NotFound } from '@feathersjs/errors'
import { feathers } from '@feathersjs/feathers'
import socketio from '@feathersjs/socketio'
import { MemoryService } from '@feathersjs/memory'

const TICK_MS = 7000

const sleep = ms => new Promise(r => setTimeout(r, ms))
const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1))

// Deterministic PRNG for the seed so every reset produces the same world.
const mulberry32 = seed => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// ----- Latency profiles -----

const LATENCY_PROFILES = {
  fast: { min: 30, max: 80 },
  realistic: { min: 120, max: 300 },
  slow: { min: 600, max: 1400 },
}
let latency = 'fast'

const latencyTick = async (multiplier = 1) => {
  const profile = LATENCY_PROFILES[latency]
  await sleep(Math.round(rand(profile.min, profile.max) * multiplier))
}

class SlowMemoryService extends MemoryService {
  // `speed` scales the active latency profile per service: reference data
  // (users/teams/labels) is quicker than row data (issues/comments).
  constructor(opts, { speed = 1 } = {}) {
    super(opts)
    this._speed = speed
  }
  async _tick() {
    await latencyTick(this._speed)
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

// ----- Services -----

const users = new SlowMemoryService({ multi: false, paginate: false }, { speed: 0.6 })
const teams = new SlowMemoryService({ multi: false, paginate: false }, { speed: 0.6 })
const labels = new SlowMemoryService({ multi: false, paginate: false }, { speed: 0.6 })
const issues = new SlowMemoryService({ multi: false, paginate: { default: 50, max: 200 } })
const comments = new SlowMemoryService(
  { multi: false, paginate: { default: 50, max: 500 } },
  { speed: 1.2 },
)
const tasks = new SlowMemoryService(
  { multi: false, paginate: { default: 100, max: 500 } },
  { speed: 0.9 },
)
const issueLabels = new SlowMemoryService(
  { multi: false, paginate: { default: 100, max: 1000 } },
  { speed: 0.8 },
)
const reactions = new SlowMemoryService(
  { multi: false, paginate: { default: 100, max: 1000 } },
  { speed: 0.8 },
)

app.use('users', users)
app.use('teams', teams)
app.use('labels', labels)
app.use('issues', issues)
app.use('comments', comments)
app.use('tasks', tasks)
app.use('issueLabels', issueLabels)
app.use('reactions', reactions)

const allServices = [users, teams, labels, issues, comments, tasks, issueLabels, reactions]

const clearStores = () => {
  for (const svc of allServices) {
    for (const key of Object.keys(svc.store)) {
      delete svc.store[key]
    }
  }
}

// ----- Seed -----

const SEED_BASE_TIME = Date.parse('2026-06-30T12:00:00.000Z')

const TITLE_LEADS = [
  'Hover state on primary button is off',
  'API returns 500 on empty search',
  'Keyboard shortcut opens wrong panel',
  'Settings page forgets selected tab',
  'Export drops custom fields',
  'Avatar upload fails over 2MB',
  'Dark mode flashes on first paint',
  'Websocket reconnect loses presence',
  'Date picker skips DST boundary',
  'Notification badge count is stale',
  'Drag reorder janks on long lists',
  'Search results flicker while typing',
  'Emoji picker crashes on paste',
  'Sidebar collapse state not persisted',
  'CSV import mangles unicode names',
  'Tooltip clipped inside modal',
  'Session expiry logs out mid-edit',
  'Rate limiter too aggressive on bursts',
  'Breadcrumbs wrong after team move',
  'Duplicate issue detection misses typos',
  'Scroll position lost on back nav',
  'Mentions autocomplete misses new users',
  'Slow query on the activity endpoint',
  'Focus ring missing on icon buttons',
  'Timezone mismatch in due dates',
  'Copy link includes stale filters',
  'Print stylesheet renders blank page',
  'Label colors fail contrast check',
  'Undo toast dismisses too quickly',
  'Long titles overflow the board card',
]

const COMMENT_BODIES = [
  'Confirmed on Safari. Chrome looks fine.',
  'Might be the :hover rule ordering.',
  'Stack trace points at the query builder.',
  'Repros 100% with a US keyboard layout.',
  'Adding myself to the thread.',
  'Can reproduce this on staging.',
  'Pushed a speculative fix.',
  'Waiting on review.',
  "I can't reproduce this on Firefox latest.",
  'Just saw this happen again on staging.',
  'Might be related to the batching change from last week.',
  'Patched a hotfix locally — will send a PR.',
  'Logged timings — the call is ~700ms on the slow path.',
  'Adding a test for this.',
  'Looks good to me 👍',
]

const EMOJIS = ['🚀', '💯', '🔥', '✨', '👏', '🎯', '👀', '🤔', '👍']

const DESCRIPTION_OPENERS = [
  'Reported by a customer on the enterprise plan.',
  'Spotted during the release QA pass.',
  'Came up in the support rotation twice this week.',
  'Regression from the last design-system bump.',
  'Flagged by the on-call engineer.',
  'Noticed while dogfooding the new build.',
]

const DESCRIPTION_DETAILS = [
  'Repro steps are straightforward — happens on every attempt.',
  'Only reproduces with a slow network profile.',
  'Seems limited to Safari so far, but needs confirmation.',
  'Likely needs a fix in both the client and the API.',
  'A workaround exists but it is not something we can ship.',
  'Suspect a race between the cache and the socket events.',
]

const seed = async () => {
  const rng = mulberry32(20260630)
  const pick = arr => arr[Math.floor(rng() * arr.length)]

  for (const t of [
    { id: 1, name: 'Core UI', accent: '#f97316' },
    { id: 2, name: 'Platform', accent: '#0ea5e9' },
    { id: 3, name: 'Data Experience', accent: '#10b981' },
    { id: 4, name: 'Mobile', accent: '#a855f7' },
  ]) {
    teams.store[t.id] = t
  }

  for (const u of [
    { id: 1, name: 'Alice', avatar: '🌸', teamId: 1 },
    { id: 2, name: 'Bob', avatar: '🐻', teamId: 1 },
    { id: 3, name: 'Carol', avatar: '🎨', teamId: 2 },
    { id: 4, name: 'Dina', avatar: '🦊', teamId: 2 },
    { id: 5, name: 'Elio', avatar: '🌊', teamId: 3 },
    { id: 6, name: 'Faye', avatar: '🪐', teamId: 3 },
    { id: 7, name: 'Gus', avatar: '🥝', teamId: 4 },
    { id: 8, name: 'Hana', avatar: '🍁', teamId: 4 },
  ]) {
    users.store[u.id] = u
  }

  for (const l of [
    { id: 1, name: 'bug', tone: 'red' },
    { id: 2, name: 'frontend', tone: 'orange' },
    { id: 3, name: 'backend', tone: 'blue' },
    { id: 4, name: 'customer-impact', tone: 'green' },
    { id: 5, name: 'regression', tone: 'slate' },
    { id: 6, name: 'perf', tone: 'orange' },
  ]) {
    labels.store[l.id] = l
  }

  const userIds = Object.keys(users.store).map(Number)
  const teamIds = Object.keys(teams.store).map(Number)
  const labelIds = Object.keys(labels.store).map(Number)

  const issueCount = 90
  let commentId = 1
  let taskId = 1
  let issueLabelId = 1
  let reactionId = 1

  for (let i = 1; i <= issueCount; i++) {
    const lead = TITLE_LEADS[(i - 1) % TITLE_LEADS.length]
    const suffix = i > TITLE_LEADS.length ? ` (${Math.ceil(i / TITLE_LEADS.length)})` : ''
    // Newest issues get the lowest age; spread over ~3 weeks with jitter.
    const ageMinutes = (i - 1) * 340 + Math.floor(rng() * 240)
    const issue = {
      id: i,
      title: `${lead}${suffix}`,
      status: rng() < 0.28 ? 'closed' : 'open',
      creatorId: pick(userIds),
      assigneeId: pick(userIds),
      teamId: pick(teamIds),
      priorityScore: Math.floor(rng() * 100),
      description: `${pick(DESCRIPTION_OPENERS)} ${pick(DESCRIPTION_DETAILS)}`,
      updatedAt: new Date(SEED_BASE_TIME - ageMinutes * 60_000).toISOString(),
      commentIds: [],
    }
    issues.store[issue.id] = issue

    // A few concrete tasks make the issue-local mutation queue immediately
    // playable. Positions are sparse so optimistic inserts can land between rows.
    const taskCount = i <= 20 ? 1 + Math.floor(rng() * 3) : Math.floor(rng() * 2)
    for (let n = 0; n < taskCount; n++) {
      const assigneeId = rng() < 0.7 ? pick(userIds) : null
      tasks.store[taskId] = {
        id: taskId,
        issueId: issue.id,
        title:
          ['Reproduce the issue', 'Confirm expected behavior', 'Ship and verify'][n] ?? 'Follow up',
        completed: n === 0 && rng() < 0.35,
        assigneeId,
        position: n + 1,
      }
      taskId++
    }

    // Labels: 0–3 distinct labels per issue.
    const labelCount = Math.floor(rng() * 4)
    const chosen = new Set()
    for (let n = 0; n < labelCount; n++) chosen.add(pick(labelIds))
    for (const labelId of chosen) {
      issueLabels.store[issueLabelId] = { id: issueLabelId, issueId: issue.id, labelId }
      issueLabelId++
    }

    // Comments: recent issues are chatty (1–5), older ones sparse.
    const isRecent = i <= 30
    const commentCount = isRecent ? 1 + Math.floor(rng() * 5) : Math.floor(rng() * 2)
    const rootCommentIds = []
    for (let n = 0; n < commentCount; n++) {
      // Single-level threading: ~35% of follow-up comments reply to an earlier root.
      const parentId = rootCommentIds.length > 0 && rng() < 0.35 ? pick(rootCommentIds) : null
      const comment = {
        id: commentId,
        issueId: issue.id,
        authorId: pick(userIds),
        parentId,
        body: pick(COMMENT_BODIES),
      }
      if (parentId === null) rootCommentIds.push(comment.id)
      comments.store[comment.id] = comment
      issue.commentIds.push(comment.id)
      // Reactions: roughly a third of comments get one or two.
      if (rng() < 0.35) {
        const rCount = 1 + Math.floor(rng() * 2)
        for (let r = 0; r < rCount; r++) {
          reactions.store[reactionId] = {
            id: reactionId,
            commentId: comment.id,
            userId: pick(userIds),
            emoji: pick(EMOJIS),
          }
          reactionId++
        }
      }
      commentId++
    }
  }

  // Server-maintained spotlights: each team's top open issues by priority.
  for (const team of Object.values(teams.store)) {
    team.spotlightIssueIds = computeSpotlight(team.id)
  }

  nextIssueId = issueCount + 1
  nextCommentId = commentId
  nextTaskId = taskId
  nextIssueLabelId = issueLabelId
  nextReactionId = reactionId
}

// ----- Server-maintained team spotlights (the embed pattern) -----

// Each team carries `spotlightIssueIds` — its top open issues by priority —
// recomputed whenever issues change and re-emitted as a patch on the team.
// Clients resolve the list with an `embed()` relation: membership and order are
// owned by the server; figbird fetches every team's spotlight in one batched
// IN(...) query and keeps it fresh from the team's own realtime events.
const SPOTLIGHT_SIZE = 3

const computeSpotlight = teamId =>
  Object.values(issues.store)
    .filter(issue => issue.teamId === teamId && issue.status === 'open')
    .sort((a, b) => b.priorityScore - a.priorityScore || a.id - b.id)
    .slice(0, SPOTLIGHT_SIZE)
    .map(issue => issue.id)

const sameIds = (a = [], b = []) => a.length === b.length && a.every((v, i) => v === b[i])

const refreshSpotlights = async () => {
  for (const team of Object.values(teams.store)) {
    const next = computeSpotlight(team.id)
    if (!sameIds(team.spotlightIssueIds, next)) {
      await app.service('teams').patch(team.id, { spotlightIssueIds: next }, { internal: true })
    }
  }
}

// Fire-and-forget after any issue change; a no-op recompute emits nothing.
const spotlightHook = context => {
  void refreshSpotlights().catch(() => {})
  return context
}

app.service('issues').hooks({
  after: {
    create: [spotlightHook],
    patch: [spotlightHook],
    remove: [spotlightHook],
  },
})

let nextIssueId = 1
let nextCommentId = 1
let nextTaskId = 1
let nextIssueLabelId = 1
let nextReactionId = 1

await seed()

// ----- Control surface -----

// The teammate simulator is ON by default — realtime is the product. Toggle it off
// from the dev-tools drawer when you want a quiet event log.
let backgroundEnabled = true

// One-shot chaos switch: when armed, the next user-originated mutation throws —
// the visible effect client-side is figbird rolling the optimistic change back.
let chaosArmed = false

const demoState = () => ({ backgroundEnabled, latency, chaosArmed })

app.use('_demo', {
  async find() {
    return demoState()
  },
  async patch(_id, data) {
    if (data && typeof data === 'object') {
      if ('backgroundEnabled' in data) backgroundEnabled = !!data.backgroundEnabled
      if ('latency' in data && data.latency in LATENCY_PROFILES) latency = data.latency
      if ('chaosArmed' in data) chaosArmed = Boolean(data.chaosArmed)
    }
    return demoState()
  },
  async create(data) {
    if (data?.action === 'reset') {
      clearStores()
      await seed()
      return { ok: true, ...demoState() }
    }
    return { ok: false }
  },
})

// Don't broadcast _demo events — they're plumbing, not domain data.
app.service('_demo').publish(() => null)

// When chaos is armed, the next user-originated write fails. Internal writes
// (the teammate simulator, commentIds maintenance) are exempt so chaos always
// hits the action the user is about to take.
const chaosHook = async context => {
  if (context.path === '_demo') return context
  if (context.params?.internal) return context
  if (chaosArmed) {
    chaosArmed = false
    throw new Error(`chaos: simulated ${context.method} failure on ${context.path}`)
  }
  return context
}

app.hooks({
  before: {
    create: [chaosHook],
    update: [chaosHook],
    patch: [chaosHook],
    remove: [chaosHook],
  },
})

// ----- Query helpers for hooks -----

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

// ----- Issues hooks: search, relational filters, timestamps -----

app.service('issues').hooks({
  before: {
    find: [
      // Two query shapes the MemoryService can't evaluate natively:
      //   - `title.$regex` — figbird's server-authoritative search sends it verbatim.
      //   - `assignee.teamId` — a relational (dotted-path) filter; resolved with a
      //     join against users, which is exactly the server contract relational
      //     filters require (see DESIGN.md "Filtering By Related Fields").
      async context => {
        const q = context.params?.query || {}
        const rx = q.title?.$regex
        const assigneeTeam = q['assignee.teamId']
        if (!rx && assigneeTeam == null) return context

        const rest = { ...q }
        delete rest['assignee.teamId']
        if (rx) delete rest.title

        let rows = Object.values(issues.store)
        if (rx) {
          const re = new RegExp(rx, q.title.$options || 'i')
          rows = rows.filter(issue => re.test(issue.title))
        }
        if (assigneeTeam != null) {
          rows = rows.filter(issue => {
            const assignee = users.store[issue.assigneeId]
            return assignee ? compare(assignee.teamId, assigneeTeam) : false
          })
        }

        // Short-circuiting skips the service method, so pay the latency here.
        await issues._tick()
        context.result = applyFindWindow(rows, rest)
        return context
      },
    ],
    create: [
      async context => {
        context.data = {
          ...context.data,
          id: context.data.id ?? nextIssueId++,
          description: context.data.description ?? '',
          commentIds: context.data.commentIds ?? [],
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

// ----- Comments hooks: ids + server-maintained commentIds on the parent issue -----

app.service('comments').hooks({
  before: {
    create: [
      async context => {
        if (!issues.store[context.data.issueId]) {
          throw new NotFound(`Issue ${String(context.data.issueId)} does not exist`)
        }
        context.data = {
          ...context.data,
          id: context.data.id ?? nextCommentId++,
          parentId: context.data.parentId ?? null,
        }
        return context
      },
    ],
  },
  after: {
    create: [
      // `issue.commentIds` is a server-maintained id list — the "embed" pattern.
      // Patching the parent re-emits it, which is what keeps clients' comment
      // counts fresh without them fetching a single comment.
      async context => {
        const issue = issues.store[context.result.issueId]
        if (issue) {
          await app
            .service('issues')
            .patch(
              issue.id,
              { commentIds: [...(issue.commentIds ?? []), context.result.id] },
              { internal: true },
            )
        }
        return context
      },
    ],
  },
})

// ----- Tasks hooks: ordered, issue-owned rows with optional user assignment -----

app.service('tasks').hooks({
  before: {
    create: [
      async context => {
        if (!issues.store[context.data.issueId]) {
          throw new NotFound(`Issue ${String(context.data.issueId)} does not exist`)
        }
        if (context.data.assigneeId != null && !users.store[context.data.assigneeId]) {
          throw new NotFound(`User ${String(context.data.assigneeId)} does not exist`)
        }
        context.data = {
          ...context.data,
          id: context.data.id ?? nextTaskId++,
          title: context.data.title ?? '',
          completed: context.data.completed ?? false,
          assigneeId: context.data.assigneeId ?? null,
          position: context.data.position ?? Date.now(),
        }
        return context
      },
    ],
    patch: [
      async context => {
        if (context.data.assigneeId != null && !users.store[context.data.assigneeId]) {
          throw new NotFound(`User ${String(context.data.assigneeId)} does not exist`)
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
        context.data = { ...context.data, id: context.data.id ?? nextIssueLabelId++ }
        return context
      },
    ],
  },
})

app.service('reactions').hooks({
  before: {
    create: [
      async context => {
        context.data = { ...context.data, id: context.data.id ?? nextReactionId++ }
        return context
      },
    ],
  },
})

// ----- Simulated teammate -----

// One weighted action per tick, through app.service() so events flow through the
// publish pipeline and reach socket subscribers.
setInterval(async () => {
  if (!backgroundEnabled) return

  const issueRows = Object.values(issues.store)
  const userIds = Object.keys(users.store).map(Number)
  if (issueRows.length === 0 || userIds.length === 0) return

  const openIssues = issueRows.filter(issue => issue.status === 'open')
  const recentIssues = issueRows
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 25)

  const roll = Math.random()
  try {
    if (roll < 0.5) {
      // Comment on a recent issue — sometimes as a reply to a recent root comment.
      const rootComments = Object.values(comments.store)
        .filter(c => c.parentId == null)
        .sort((a, b) => b.id - a.id)
        .slice(0, 20)
      const reply = rootComments.length > 0 && Math.random() < 0.35
      const parent = reply ? rootComments[rand(0, rootComments.length - 1)] : null
      const issue = parent ?? recentIssues[rand(0, recentIssues.length - 1)]
      await app.service('comments').create(
        {
          issueId: parent ? parent.issueId : issue.id,
          authorId: userIds[rand(0, userIds.length - 1)],
          parentId: parent ? parent.id : null,
          body: COMMENT_BODIES[rand(0, COMMENT_BODIES.length - 1)],
        },
        { internal: true },
      )
    } else if (roll < 0.7) {
      // React to a recent comment.
      const commentIds = Object.keys(comments.store).map(Number)
      if (commentIds.length === 0) return
      const recent = commentIds.sort((a, b) => b - a).slice(0, 30)
      await app.service('reactions').create(
        {
          commentId: recent[rand(0, recent.length - 1)],
          userId: userIds[rand(0, userIds.length - 1)],
          emoji: EMOJIS[rand(0, EMOJIS.length - 1)],
        },
        { internal: true },
      )
    } else if (roll < 0.85) {
      // Nudge an open issue's priority.
      if (openIssues.length === 0) return
      const issue = openIssues[rand(0, openIssues.length - 1)]
      await app
        .service('issues')
        .patch(
          issue.id,
          { priorityScore: Math.max(1, Math.min(99, issue.priorityScore + rand(-6, 10))) },
          { internal: true },
        )
    } else {
      // Close an open issue, or reopen a closed one.
      const closeable = roll < 0.93 ? openIssues : issueRows.filter(i => i.status === 'closed')
      if (closeable.length === 0) return
      const issue = closeable[rand(0, closeable.length - 1)]
      await app
        .service('issues')
        .patch(
          issue.id,
          { status: issue.status === 'open' ? 'closed' : 'open' },
          { internal: true },
        )
    }
  } catch {
    // A racing reset can invalidate ids mid-tick; skip the beat.
  }
}, TICK_MS)

// ----- Start -----

const PORT = Number(process.env.PORT) || 5273

app.listen(PORT).then(() => {
  console.log(`[figbird-demo] server listening on http://localhost:${PORT}`)
  console.log(
    `[figbird-demo] latency profile "${latency}" (fast 30-80 / realistic 120-300 / slow 600-1400 ms) — switch via dev tools`,
  )
  console.log(
    `[figbird-demo] simulated teammate ON, one action every ${TICK_MS}ms — toggle via dev tools`,
  )
})
