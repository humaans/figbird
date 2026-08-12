import type { FeathersClient } from '../../lib'
import { createSchema, service, FeathersAdapter, Figbird } from '../../lib'

interface EsignInstance {
  id: string
  status: 'draft' | 'sent'
}

interface SendDocumentOptions {
  notifySigner?: boolean
}

interface SendDocumentResult {
  id: string
  status: 'sent'
  sentAt: string
}

interface EsignInstanceService {
  item: EsignInstance
  methods: {
    requestSendDocument: (id: string, options?: SendDocumentOptions) => Promise<SendDocumentResult>
    voidDocument: (id: string, reason: string) => Promise<{ id: string; voided: true }>
  }
}

interface MessageService {
  item: { id: string; body: string }
  methods: {
    sendMessage: (body: string) => Promise<{ id: string }>
  }
}

const schema = createSchema({
  services: {
    'api/esign-instances': service<EsignInstanceService>(),
    'api/messages': service<MessageService>(),
  },
})

const feathers = {} as FeathersClient
const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ schema, adapter })
const { m } = figbird

// Custom methods declared in the schema appear directly on the handle, typed —
// on the default (optimistic) handle and on the confirmed variant alike.
const requestPromise = m['api/esign-instances'].requestSendDocument('esign_1', {
  notifySigner: true,
})
const confirmedPromise = m['api/esign-instances'].confirmed.requestSendDocument('esign_1')

export type RequestSendArgs = Parameters<(typeof m)['api/esign-instances']['requestSendDocument']>
export type RequestSendResult = Awaited<typeof requestPromise>
export type ConfirmedResult = Awaited<typeof confirmedPromise>

// CRUD stays typed from the service definition.
const patchPromise = m['api/esign-instances'].patch('esign_1', { status: 'sent' })
export type PatchResult = Awaited<typeof patchPromise>

// Only declared method names exist on the handle — undeclared ones are rejected.
// `call()` is the untyped escape hatch.
// @ts-expect-error - unknown method names are rejected
m['api/esign-instances'].notARealMethod('x')
const escapeHatch = m['api/esign-instances'].call('notInSchema', 'x', 1)
export type EscapeHatchResult = Awaited<typeof escapeHatch>

// @ts-expect-error - custom method args are inferred
m['api/esign-instances'].requestSendDocument(123, { notifySigner: true })

// @ts-expect-error - custom method return type is preserved
export const invalidResult: Promise<{ id: string; status: 'draft' }> =
  m['api/esign-instances'].requestSendDocument('esign_1')

// @ts-expect-error - the confirmed variant has no nested confirmed
export const nestedConfirmed = m['api/esign-instances'].confirmed.confirmed

// @ts-expect-error - unknown service names are rejected on the proxy
export const unknownService = m.notAService
