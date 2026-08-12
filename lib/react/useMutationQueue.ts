import { useEffect, useRef, useSyncExternalStore } from 'react'
import { MutationQueue, type MutationQueueConfig } from '../core/mutationQueue.js'
import type { Schema } from '../core/schema.js'
import { useFigbird } from './context.js'

export interface MutationQueueHost<S extends Schema> {
  createMutationQueue(config?: MutationQueueConfig): MutationQueue<S>
  getMutationQueue(key: string, config?: MutationQueueConfig): MutationQueue<S>
  retainMutationQueue(key: string, queue: MutationQueue<S>): () => void
}

export interface UseMutationQueueConfig extends MutationQueueConfig {
  /** Reconnect components using the same Figbird instance and queue key. */
  key?: string
}

export type UseMutationQueueHook<S extends Schema> = (
  config?: UseMutationQueueConfig,
) => MutationQueue<S>

/**
 * Create one serial mutation queue for the lifetime of the calling component.
 * Share the returned object through feature context when several components
 * contribute to the same stream of edits. Pass a key to reconnect components
 * on the same Figbird instance while that queue still has unfinished work.
 */
export function useMutationQueue(config: UseMutationQueueConfig = {}): MutationQueue<Schema> {
  return useMutationQueueImpl(useFigbird(), config)
}

/** Instance-taking implementation used by createHooks. @internal */
export function useMutationQueueImpl<S extends Schema>(
  figbird: MutationQueueHost<S>,
  config: UseMutationQueueConfig = {},
): MutationQueue<S> {
  const { key, ...queueConfig } = config
  const ref = useRef<{
    host: MutationQueueHost<S>
    key: string | undefined
    queue: MutationQueue<S>
  } | null>(null)
  const mountedQueues = useRef(new Set<MutationQueue<S>>())
  if (!ref.current || ref.current.host !== figbird || ref.current.key !== key) {
    ref.current = {
      host: figbird,
      key,
      queue:
        key === undefined
          ? figbird.createMutationQueue(queueConfig)
          : figbird.getMutationQueue(key, queueConfig),
    }
  }

  const queue = ref.current.queue
  const activeQueues = mountedQueues.current
  useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot)
  useEffect(() => {
    queue.setConfig(queueConfig)
  }, [queue, queueConfig])
  useEffect(() => {
    if (key !== undefined) return figbird.retainMutationQueue(key, queue)
    activeQueues.add(queue)
    return () => {
      activeQueues.delete(queue)
      queueMicrotask(() => {
        if (!activeQueues.has(queue)) queue.detach()
      })
    }
  }, [activeQueues, figbird, key, queue])
  return queue
}
