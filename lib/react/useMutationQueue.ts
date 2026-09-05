import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
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
  (): MutationQueue<S>
  (definition: MutationQueueDefinition): MutationQueue<S>
  (definition: MutationQueueDefinition, key: string): MutationQueue<S>
}

const DEFAULT_MUTATION_QUEUE = defineMutationQueue()

/**
 * Create a serial mutation queue for the lifetime of the calling component.
 * Pass an instance key to reconnect to unfinished work after a remount. Queue
 * policy belongs to an immutable definition, which should live at module scope.
 */
export function useMutationQueue(): MutationQueue<Schema>
export function useMutationQueue(definition: MutationQueueDefinition): MutationQueue<Schema>
export function useMutationQueue(
  definition: MutationQueueDefinition,
  key: string,
): MutationQueue<Schema>
export function useMutationQueue(
  definition?: MutationQueueDefinition,
  key?: string,
): MutationQueue<Schema> {
  return useMutationQueueImpl(useFigbird(), definition, key)
}

/** Instance-taking implementation used by createHooks. @internal */
export function useMutationQueueImpl<S extends Schema>(
  figbird: MutationQueueHost<S>,
  definition?: MutationQueueDefinition,
  key?: string,
): MutationQueue<S> {
  if (key !== undefined && definition === undefined) {
    throw new Error('figbird: a keyed mutation queue requires a definition')
  }
  const resolvedDefinition = definition ?? DEFAULT_MUTATION_QUEUE
  const queue = useMemo(
    () =>
      key === undefined
        ? figbird.createMutationQueue(mutationQueueDefinitionConfig(resolvedDefinition))
        : figbird.getMutationQueue(resolvedDefinition, key),
    [figbird, resolvedDefinition, key],
  )
  const mountedQueues = useRef(new Set<MutationQueue<S>>())
  useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot)
  useEffect(() => {
    if (key !== undefined) return figbird.retainMutationQueue(resolvedDefinition, key, queue)
    const activeQueues = mountedQueues.current
    activeQueues.add(queue)
    return () => {
      activeQueues.delete(queue)
      queueMicrotask(() => {
        if (!activeQueues.has(queue)) queue.detach()
      })
    }
  }, [figbird, key, queue, resolvedDefinition])
  return queue
}
