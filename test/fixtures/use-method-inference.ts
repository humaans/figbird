import type { FeathersClient } from '../../lib'
import { createHooks, createSchema, service, FeathersAdapter, Figbird } from '../../lib'

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
const { useMethod } = createHooks(figbird)

const [requestSendDocument, requestSendDocumentState] = useMethod(
  'api/esign-instances',
  'requestSendDocument',
)
const requestPromise = requestSendDocument('esign_1', { notifySigner: true })

export type RequestSendArgs = Parameters<typeof requestSendDocument>
export type RequestSendResult = Awaited<ReturnType<typeof requestSendDocument>>
export type RequestSendPromiseResult = Awaited<typeof requestPromise>
export type RequestSendData = typeof requestSendDocumentState.data

// Note: the schema's DeriveMethods intersects declared methods with a generic
// methods map, so unknown method names are not rejected at the type level —
// only declared methods get precise arg/return inference (asserted below).

// @ts-expect-error - custom method args are inferred
requestSendDocument(123, { notifySigner: true })

// @ts-expect-error - custom method return type is preserved
export const invalidResult: Promise<{ id: string; status: 'draft' }> =
  requestSendDocument('esign_1')
