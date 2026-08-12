import type { FeathersClient } from '../adapters/feathers.js'
import { useFigbird } from './context.js'

/**
 * Specific to Feathers adapter. Might remove in the future.
 */
/**
 * Returns the underlying Feathers client — the supported escape hatch for one-off
 * operations outside Figbird's caching layer. Typed (including custom methods
 * declared in the schema) when obtained from `createHooks(schema)`.
 */
export function useFeathers(): FeathersClient {
  const figbird = useFigbird()
  const adapter = figbird.adapter as { feathers?: FeathersClient }

  if (!adapter?.feathers) {
    throw new Error('useFeathers must be used with a Feathers adapter')
  }

  return adapter.feathers
}
