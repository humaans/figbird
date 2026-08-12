import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  defineMutationQueue,
  MutationQueue,
  mutationQueueDefinitionConfig,
  type MutationQueueConfig,
  type MutationQueueDefinition,
} from '../core/mutationQueue.js'
import type { Schema } from '../core/schema.js'
import { useFigbird } from './context.js'

export interface MutationQueueHost<S extends Schema> {
  createMutationQueue(config?: MutationQueueConfig): MutationQueue<S>
  getMutationQueue(definition: MutationQueueDefinition, key: string): MutationQueue<S>
  retainMutationQueue(
    definition: MutationQueueDefinition,
    key: string,
    queue: MutationQueue<S>,
  ): () => void
}

export interface UseMutationQueueHook<S extends Schema> {
  (definition?: MutationQueueDefinition, key?: string): MutationQueue<S>
}

const DEFAULT_MUTATION_QUEUE = defineMutationQueue()

/**
 * Create a serial mutation queue for the lifetime of the calling component.
 * Pass an instance key to reconnect to unfinished work after a remount. Queue
 * policy belongs to an immutable definition, which should live at module scope.
 */
export function useMutationQueue(
  definition?: MutationQueueDefinition,
  key?: string,
): MutationQueue<Schema> {
  return useMutationQueueImpl(useFigbird(), definition, key)
}

/** Instance-taking implementation used by createHooks. @internal */
export function useMutationQueueImpl<S extends Schema>(
  figbird: MutationQueueHost<S>,
  definition: MutationQueueDefinition = DEFAULT_MUTATION_QUEUE,
  key?: string,
): MutationQueue<S> {
  const ref = useRef<{
    host: MutationQueueHost<S>
    definition: MutationQueueDefinition
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
      queue:
        key === undefined
          ? figbird.createMutationQueue(mutationQueueDefinitionConfig(definition))
          : figbird.getMutationQueue(definition, key),
    }
  }

  const queue = ref.current.queue
  const activeQueues = mountedQueues.current
  useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot)
  useEffect(() => {
    if (key !== undefined) return figbird.retainMutationQueue(definition, key, queue)
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
