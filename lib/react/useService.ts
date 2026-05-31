import type { FeathersClient, FeathersService } from '../adapters/feathers.js'
import { findServiceByName } from '../core/schema.js'
import { useFigbird } from './react.js'

/**
 * Specific to Feathers adapter. Returns an untyped Feathers service.
 * For schema-aware service types, prefer `createHooks(figbird).useService`.
 */
export function useService(serviceName: string): FeathersService {
  const figbird = useFigbird()
  const adapter = figbird.adapter as { feathers?: FeathersClient }

  if (!adapter?.feathers) {
    throw new Error('useService must be used with a Feathers adapter')
  }

  const service = findServiceByName(figbird.schema, serviceName)
  return adapter.feathers.service(service?.name ?? serviceName)
}
