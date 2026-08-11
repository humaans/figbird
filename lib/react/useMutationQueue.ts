import { useEffect, useRef, useSyncExternalStore } from 'react'
import { MutationQueue, type MutationQueueConfig } from '../core/mutationQueue.js'
import type { Schema } from '../core/schema.js'
import { useFigbird } from './context.js'

export interface MutationQueueHost<S extends Schema> {
  createMutationQueue(config?: MutationQueueConfig): MutationQueue<S>
}

export type UseMutationQueueHook<S extends Schema> = (
  config?: MutationQueueConfig,
) => MutationQueue<S>

/**
 * Create one serial mutation queue for the lifetime of the calling component.
 * Share the returned object through feature context when several components
 * contribute to the same stream of edits.
 */
export function useMutationQueue(config: MutationQueueConfig = {}): MutationQueue<Schema> {
  return useMutationQueueImpl(useFigbird(), config)
}

/** Instance-taking implementation used by createHooks. @internal */
export function useMutationQueueImpl<S extends Schema>(
  figbird: MutationQueueHost<S>,
  config: MutationQueueConfig = {},
): MutationQueue<S> {
  const ref = useRef<{ host: MutationQueueHost<S>; queue: MutationQueue<S> } | null>(null)
  const mountedQueues = useRef(new Set<MutationQueue<S>>())
  if (!ref.current || ref.current.host !== figbird) {
    ref.current = {
      host: figbird,
      queue: figbird.createMutationQueue(config),
    }
  }

  const queue = ref.current.queue
  const activeQueues = mountedQueues.current
  queue.setConfig(config)
  useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot)
  useEffect(() => {
    activeQueues.add(queue)
    return () => {
      activeQueues.delete(queue)
      queueMicrotask(() => {
        if (!activeQueues.has(queue)) queue.detach()
      })
    }
  }, [activeQueues, queue])
  return queue
}
