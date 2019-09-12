import { useEffect } from 'react'
import { useFigbird } from './core'
import { namespace } from './namespace'
import { getIn } from './helpers'

/**
 * An internal hook that will listen to realtime updates to a service
 * and update the cache as changes happen.
 */
export function useRealtime(serviceName) {
  const { feathers, atom, actions } = useFigbird()

  useEffect(() => {
    const service = feathers.service(serviceName)
    const curr = getIn(atom.get(), [namespace])
    const listening = getIn(curr, ['meta', serviceName, 'listening'])

    if (listening) return

    actions.feathersListening({ serviceName, listening: true })

    const params = entity => ({ serviceName, entity })
    const created = entity => actions.feathersCreated(params(entity))
    const updated = entity => actions.feathersUpdated(params(entity))
    const patched = entity => actions.feathersPatched(params(entity))
    const removed = entity => actions.feathersRemoved(params(entity))

    service
      .on('created', created)
      .on('updated', updated)
      .on('patched', patched)
      .on('removed', removed)

    return () => {
      // only 1 component can listen at a time
      // TODO - if this gets unmounted means no component is listening anymore...
      const curr = atom.get()
      const listeningPath = [namespace, 'meta', serviceName, 'listening']
      const listening = getIn(curr, listeningPath)

      if (listening) return

      actions.feathersListening({ serviceName, listening: false })

      service
        .off('created', created)
        .off('updated', updated)
        .off('patched', patched)
        .off('removed', removed)
    }
  }, [serviceName])
}
