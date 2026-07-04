import type { FeathersClient, FeathersService } from '../adapters/feathers.js'
import { resolveServicePath } from '../core/schema.js'
import { useFigbird } from './react.js'

/**
 * Specific to Feathers adapter. Returns an untyped Feathers service.
 * For schema-aware service types, prefer `createHooks(figbird).useService`.
 */
/**
 * @deprecated Feathers-specific escape hatch from the descriptor era; it stays
 * functional but is not part of the current API surface.
 */
export function useService(serviceName: string): FeathersService {
  const figbird = useFigbird()
  const adapter = figbird.adapter as { feathers?: FeathersClient }

  if (!adapter?.feathers) {
    throw new Error('useService must be used with a Feathers adapter')
  }

  return adapter.feathers.service(resolveServicePath(figbird.schema, serviceName))
}
