/**
 * Figbird schema + client instance shared by every component in the demo.
 */

import { Figbird, FeathersAdapter, createHooks, createSchema, service } from 'figbird'
import { feathers } from '@feathersjs/feathers'
import socketio from '@feathersjs/socketio-client'
import { io } from 'socket.io-client'

// ----- Domain types -----

export interface User {
  id: number
  name: string
  avatar: string
  teamId: number
}
export interface Team {
  id: number
  name: string
  accent: string
  /**
   * Server-maintained id list: the team's top open issues by priority, recomputed
   * whenever issues change and re-emitted as a team patch. Resolved on the client
   * through the `spotlight` embed() relation.
   */
  spotlightIssueIds: number[]
}
export interface Issue {
  id: number
  title: string
  description: string
  status: 'open' | 'closed'
  creatorId: number
  assigneeId: number
  teamId: number
  priorityScore: number
  updatedAt: string
  /**
   * Server-maintained id list — updated by the server whenever a comment is
   * created, so list rows can show comment counts without fetching a single
   * comment (the "embed" pattern).
   */
  commentIds: number[]
}
export interface ArchivedIssue {
  id: number
  title: string
  assigneeId: number
  teamId: number
  deletedAt: string
  deletionReason: string
}
export interface Comment {
  id: number
  issueId: number
  authorId: number
  /** Single-level threading: replies point at a root comment, never at a reply. */
  parentId: number | null
  body: string
}
export interface Label {
  id: number
  name: string
  tone: string
}
export interface IssueLabel {
  id: number
  issueId: number
  labelId: number
}
export interface Task {
  id: number
  issueId: number
  title: string
  completed: boolean
  assigneeId: number | null
  position: number
}
export interface Reaction {
  id: number
  commentId: number
  userId: number
  emoji: string
}

// ----- Schema wiring -----

export const schema = createSchema({
  services: {
    users: service<{ item: User }>(),
    teams: service<{ item: Team }>(),
    issues: service<{ item: Issue }>(),
    archivedIssues: service<{ item: ArchivedIssue }>(),
    comments: service<{ item: Comment }>(),
    labels: service<{ item: Label }>(),
    issueLabels: service<{ item: IssueLabel }>(),
    tasks: service<{ item: Task }>(),
    reactions: service<{ item: Reaction }>(),
  },
  // destField defaults to 'id'; string fields cover the common single-key case.
  relationships: {
    issues: ({ one, many }) => ({
      creator: one({ sourceField: 'creatorId', destService: 'users' }),
      assignee: one({ sourceField: 'assigneeId', destService: 'users' }),
      team: one({ sourceField: 'teamId', destService: 'teams' }),
      comments: many({ sourceField: 'id', destService: 'comments', destField: 'issueId' }),
      tasks: many({ sourceField: 'id', destService: 'tasks', destField: 'issueId' }),
      issueLabels: many({ sourceField: 'id', destService: 'issueLabels', destField: 'issueId' }),
      // Transparent two-hop junction: consumers say `.related('labels')` and get
      // Label[] directly — figbird fetches the issueLabels junction, then the
      // labels, and hides the join. Realtime events on either service (e.g. a new
      // issueLabels row) flow into the assembled result.
      labels: many(
        { sourceField: 'id', destService: 'issueLabels', destField: 'issueId' },
        { sourceField: 'labelId', destService: 'labels' },
      ),
    }),
    archivedIssues: ({ one, many }) => ({
      assignee: one({ sourceField: 'assigneeId', destService: 'users' }),
      team: one({ sourceField: 'teamId', destService: 'teams' }),
      labels: many(
        { sourceField: 'id', destService: 'issueLabels', destField: 'issueId' },
        { sourceField: 'labelId', destService: 'labels' },
      ),
    }),
    teams: ({ many, embed }) => ({
      members: many({ sourceField: 'id', destService: 'users', destField: 'teamId' }),
      // embed(): the parent carries a server-maintained list of dest ids — figbird
      // fans every team's spotlightIssueIds into ONE batched IN(...) fetch and
      // assembles per-team slices preserving the server-chosen order. Membership
      // and ordering are owned by the server; freshness comes from the team's own
      // realtime events (the server re-emits the team when the list changes).
      spotlight: embed({ sourceField: 'spotlightIssueIds', destService: 'issues' }),
      // Used with a per-team window (`.orderBy().limit()`), which fans out one
      // query per team — fine at 4 teams, and exactly the shape the fan-out
      // warning + embed pattern exist for at larger scales.
      recentIssues: many({ sourceField: 'id', destService: 'issues', destField: 'teamId' }),
    }),
    users: ({ one }) => ({
      team: one({ sourceField: 'teamId', destService: 'teams' }),
    }),
    issueLabels: ({ one }) => ({
      label: one({ sourceField: 'labelId', destService: 'labels' }),
    }),
    comments: ({ one, many }) => ({
      author: one({ sourceField: 'authorId', destService: 'users' }),
      reactions: many({ sourceField: 'id', destService: 'reactions', destField: 'commentId' }),
    }),
    tasks: ({ one }) => ({
      assignee: one({ sourceField: 'assigneeId', destService: 'users' }),
    }),
    reactions: ({ one }) => ({
      user: one({ sourceField: 'userId', destService: 'users' }),
    }),
  },
})

// ----- Socket.IO client + Feathers adapter -----

const demoServerUrl = import.meta.env.VITE_DEMO_SERVER_URL ?? 'http://localhost:5273'

// Exported so the dev-tools drawer can simulate a dropped connection — closing the
// underlying engine triggers socket.io's auto-reconnect, and figbird's adapter
// refetches every active query on the Manager's 'reconnect' event.
export const socket = io(demoServerUrl, {
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 500,
})

export const feathersClient = feathers()
feathersClient.configure(socketio(socket))

const adapter = new FeathersAdapter(feathersClient as never)

export const figbird = new Figbird({ schema, adapter })

// Pure, schema-bound React API. FigbirdProvider supplies the runtime instance;
// useMutations returns its typed write proxy inside components.
export const {
  useQuery,
  useQueries,
  q,
  useMutations,
  defineQuery,
  useAction,
  useMutating,
  useMutationQueue,
} = createHooks(schema)

// Reference data: preload the complete sets once — realtime maintains them, and every
// later read against these services (filters, sorts, windows, relation fetches) is
// answered locally from the materialized cache with no roundtrip.
figbird.prepare(defineQuery('allUsers', () => q.users.all()))
figbird.prepare(defineQuery('allTeams', () => q.teams.all()))
figbird.prepare(defineQuery('allLabels', () => q.labels.all()))
