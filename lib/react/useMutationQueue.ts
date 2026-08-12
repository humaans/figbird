import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  CREATE_DYNAMIC_MUTATION_QUEUE,
  isMutationQueueDefinition,
  MutationQueue,
  type MutationQueueConfig,
  type MutationQueueDefinition,
} from '../core/mutationQueue.js'
import type { Schema } from '../core/schema.js'
import { useFigbird } from './context.js'

export interface MutationQueueHost<S extends Schema> {
  createMutationQueue(config?: MutationQueueConfig): MutationQueue<S>
  [CREATE_DYNAMIC_MUTATION_QUEUE](readConfig: () => MutationQueueConfig): MutationQueue<S>
  getMutationQueue(definition: MutationQueueDefinition, key: string): MutationQueue<S>
  retainMutationQueue(
    definition: MutationQueueDefinition,
    key: string,
    queue: MutationQueue<S>,
  ): () => void
}

/** Configuration for a component-owned, unkeyed mutation queue. */
export type UseMutationQueueConfig = MutationQueueConfig

export interface UseMutationQueueHook<S extends Schema> {
  (config?: UseMutationQueueConfig): MutationQueue<S>
  (definition: MutationQueueDefinition, key: string): MutationQueue<S>
}

/**
 * Create a serial mutation queue for the lifetime of the calling component.
 * Pass a queue definition and key to reconnect to unfinished work after a
 * remount. The definition owns policy; the key only selects an instance.
 */
export function useMutationQueue(config?: UseMutationQueueConfig): MutationQueue<Schema>
export function useMutationQueue(
  definition: MutationQueueDefinition,
  key: string,
): MutationQueue<Schema>
export function useMutationQueue(
  definitionOrConfig: MutationQueueDefinition | UseMutationQueueConfig = {},
  key?: string,
): MutationQueue<Schema> {
  return useMutationQueueImpl(useFigbird(), definitionOrConfig, key)
}

/** Instance-taking implementation used by createHooks. @internal */
export function useMutationQueueImpl<S extends Schema>(
  figbird: MutationQueueHost<S>,
  definitionOrConfig: MutationQueueDefinition | UseMutationQueueConfig = {},
  key?: string,
): MutationQueue<S> {
  const definition = isMutationQueueDefinition(definitionOrConfig) ? definitionOrConfig : undefined
  if (definition && key === undefined) {
    throw new Error('figbird: reconnectable mutation queues need an instance key')
  }
  if (!definition && key !== undefined) {
    throw new Error('figbird: mutation queue keys need a definition from defineMutationQueue()')
  }

  const config: MutationQueueConfig | undefined = definition
    ? undefined
    : (definitionOrConfig as MutationQueueConfig)
  const configRef = useRef(config ?? {})
  configRef.current = config ?? {}
  const ref = useRef<{
    host: MutationQueueHost<S>
    definition: MutationQueueDefinition | undefined
    key: string | undefined
    queue: MutationQueue<S>
  } | null>(null)
  const mountedQueues = useRef(new Set<MutationQueue<S>>())
  if (
    !ref.current ||
    ref.current.host !== figbird ||
    ref.current.definition !== definition ||
    ref.current.key !== key
  ) {
    ref.current = {
      host: figbird,
      definition,
      key,
      queue: definition
        ? figbird.getMutationQueue(definition, key as string)
        : figbird[CREATE_DYNAMIC_MUTATION_QUEUE](() => configRef.current),
    }
  }

  const queue = ref.current.queue
  const activeQueues = mountedQueues.current
  useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot)
  useEffect(() => {
    if (definition) return figbird.retainMutationQueue(definition, key as string, queue)
    activeQueues.add(queue)
    return () => {
      activeQueues.delete(queue)
      queueMicrotask(() => {
        if (!activeQueues.has(queue)) queue.detach()
      })
    }
  }, [activeQueues, definition, figbird, key, queue])
  return queue
}
