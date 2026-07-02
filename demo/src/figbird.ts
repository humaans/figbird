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
}
export interface Team {
  id: number
  name: string
  accent: string
}
export interface Issue {
  id: number
  title: string
  status: 'open' | 'closed'
  creatorId: number
  assigneeId: number
  teamId: number
  priorityScore: number
  updatedAt: string
}
export interface Comment {
  id: number
  issueId: number
  authorId: number
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
export interface Reaction {
  id: number
  commentId: number
  userId: number
  emoji: string
}
export interface Company {
  id: number
  name: string
  segment: string
}
export interface OrgUnit {
  id: number
  label: string
  color: string
}
export interface Person {
  id: number
  companyId: number
  orgUnitId: number
  name: string
  status: 'active' | 'inactive'
  startDate: string
  role: string
}
export interface Document {
  id: number
  title: string
  personId: number
  status: 'draft' | 'published'
  createdAt: string
}

// ----- Schema wiring -----

export const schema = createSchema({
  services: {
    users: service<{ item: User }>(),
    teams: service<{ item: Team }>(),
    issues: service<{ item: Issue }>(),
    comments: service<{ item: Comment }>(),
    labels: service<{ item: Label }>(),
    issueLabels: service<{ item: IssueLabel }>(),
    reactions: service<{ item: Reaction }>(),
    companies: service<{ item: Company }>(),
    people: service<{ item: Person }>(),
    orgUnits: service<{ item: OrgUnit }>(),
    documents: service<{ item: Document }>(),
  },
  relationships: ({ one, many }) => ({
    issues: {
      creator: one({ sourceField: ['creatorId'], destService: 'users', destField: ['id'] }),
      assignee: one({ sourceField: ['assigneeId'], destService: 'users', destField: ['id'] }),
      team: one({ sourceField: ['teamId'], destService: 'teams', destField: ['id'] }),
      comments: many({ sourceField: ['id'], destService: 'comments', destField: ['issueId'] }),
      issueLabels: many({
        sourceField: ['id'],
        destService: 'issueLabels',
        destField: ['issueId'],
      }),
    },
    issueLabels: {
      label: one({ sourceField: ['labelId'], destService: 'labels', destField: ['id'] }),
    },
    comments: {
      author: one({ sourceField: ['authorId'], destService: 'users', destField: ['id'] }),
      reactions: many({ sourceField: ['id'], destService: 'reactions', destField: ['commentId'] }),
    },
    reactions: {
      user: one({ sourceField: ['userId'], destService: 'users', destField: ['id'] }),
    },
    companies: {
      people: many({ sourceField: ['id'], destService: 'people', destField: ['companyId'] }),
    },
    people: {
      orgUnit: one({ sourceField: ['orgUnitId'], destService: 'orgUnits', destField: ['id'] }),
    },
    documents: {
      person: one({ sourceField: ['personId'], destService: 'people', destField: ['id'] }),
    },
  }),
})

// ----- Socket.IO client + Feathers adapter -----

const demoServerUrl = import.meta.env.VITE_DEMO_SERVER_URL ?? 'http://localhost:3030'

const socket = io(demoServerUrl, {
  transports: ['websocket'],
  reconnection: true,
})

const feathersClient = feathers()
feathersClient.configure(socketio(socket))

const adapter = new FeathersAdapter(feathersClient as never)

export const figbird = new Figbird({ schema, adapter })

/**
 * Off-schema control surface to talk to the demo server's `_demo` service.
 * Lets the dev-tools panel toggle background traffic and reset the seed.
 */
export interface DemoControl {
  getState(): Promise<{ backgroundEnabled: boolean }>
  setBackgroundEnabled(enabled: boolean): Promise<{ backgroundEnabled: boolean }>
  reset(): Promise<{ ok: boolean }>
}

const demoService = feathersClient.service('_demo') as unknown as {
  find(): Promise<{ backgroundEnabled: boolean }>
  patch(id: null, data: { backgroundEnabled: boolean }): Promise<{ backgroundEnabled: boolean }>
  create(data: { action: 'reset' }): Promise<{ ok: boolean }>
}

export const demoControl: DemoControl = {
  getState: () => demoService.find(),
  setBackgroundEnabled: enabled => demoService.patch(null, { backgroundEnabled: enabled }),
  reset: () => demoService.create({ action: 'reset' }),
}

// Dev-only: expose on window so we can poke from the console.
if (import.meta.env.DEV) {
  ;(window as unknown as { figbird: typeof figbird }).figbird = figbird
}

// Typed hooks bound to this schema — these are what components reach for.
export const { useQuery, useMutation } = createHooks(figbird)
