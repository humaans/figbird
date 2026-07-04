import type { FeathersClient } from '../adapters/feathers.js'
import { useFigbird } from './react.js'

/**
 * Specific to Feathers adapter. Might remove in the future.
 */
/**
 * @deprecated Feathers-specific escape hatch from the descriptor era; it stays
 * functional but is not part of the current API surface.
 */
export function useFeathers(): FeathersClient {
  const figbird = useFigbird()
  const adapter = figbird.adapter as { feathers?: FeathersClient }

  if (!adapter?.feathers) {
    throw new Error('useFeathers must be used with a Feathers adapter')
  }

  return adapter.feathers
}
