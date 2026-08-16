import type { FeathersClient } from '../../lib'
import {
  createSchema,
  defineMutationQueue,
  service,
  FeathersAdapter,
  Figbird,
  useMutationQueue,
} from '../../lib'

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
  patch: Partial<EsignInstance>
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

// Transactions reuse the schema-typed CRUD surface but collect synchronously.
export const transactionPromise = figbird.transaction(tx => {
  tx.m['api/esign-instances'].patch('esign_1', { status: 'sent' })
  tx.m['api/messages'].confirmed.create({ id: 'message_1', body: 'Ready' })
  // @ts-expect-error - transaction patches retain the service patch type
  tx.m['api/esign-instances'].patch('esign_1', { status: 'void' })
  // @ts-expect-error - the transaction DSL does not imply custom methods are atomic
  tx.m['api/esign-instances'].requestSendDocument('esign_1')
})

// @ts-expect-error - transaction callbacks must collect synchronously
figbird.transaction(async tx => {
  tx.m['api/esign-instances'].patch('esign_1', { status: 'sent' })
})

// Projection options are available only where the runtime applies them.
m['api/esign-instances'].create(
  { id: 'esign_2', status: 'draft' },
  { optimisticItem: { id: 'esign_2', status: 'draft' } },
)
m['api/esign-instances'].patch(
  'esign_1',
  { status: 'sent' },
  { optimisticPatch: { status: 'sent' } },
)
// @ts-expect-error - create accepts a complete optimistic item, not a patch
m['api/esign-instances'].create({ id: 'esign_3', status: 'draft' }, { optimisticPatch: {} })
// @ts-expect-error - remove has no optimistic projection options
m['api/esign-instances'].remove('esign_1', { optimisticItem: { id: 'esign_1', status: 'draft' } })
// @ts-expect-error - confirmed writes never accept optimistic projection options
m['api/esign-instances'].confirmed.patch('esign_1', {}, { optimisticPatch: {} })

// The descriptor layer also prevents conflicting complete-item and patch projections.
const conflictingProjection = {
  serviceName: 'api/esign-instances',
  method: 'patch',
  id: 'esign_1',
  data: { status: 'sent' },
  optimistic: { id: 'esign_1', status: 'sent' },
  optimisticPatch: { status: 'sent' },
} as const
// @ts-expect-error - an explicit optimistic item and optimisticPatch are mutually exclusive
figbird.mutateDesc(conflictingProjection)

const autosaveQueue = defineMutationQueue()
useMutationQueue(autosaveQueue, 'esign:1')
// @ts-expect-error - keyed queues require a definition to namespace their identity
useMutationQueue(undefined, 'esign:1')

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
