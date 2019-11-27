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
    // get the ref store of this service
    const refs = getIn(atom.get(), [namespace, 'meta', 'refs'])
    refs[serviceName] = refs[serviceName] || {}
    refs[serviceName].realtime = refs[serviceName].realtime || 0
    const ref = refs[serviceName]

    // get the service itself
    const service = feathers.service(serviceName)

    // increment the listener counter
    ref.realtime += 1

    // bind to the realtime events, but only once globally per service
    if (ref.realtime === 1) {
      ref.created = entity => actions.feathersCreated({ serviceName, entity })
      ref.updated = entity => actions.feathersUpdated({ serviceName, entity })
      ref.patched = entity => actions.feathersPatched({ serviceName, entity })
      ref.removed = entity => actions.feathersRemoved({ serviceName, entity })

      service.on('created', ref.created)
      service.on('updated', ref.updated)
      service.on('patched', ref.patched)
      service.on('removed', ref.removed)
    }

    return () => {
      // decrement the listener counter
      ref.realtime -= 1

      // unbind from the realtime events if nothing is listening anymore
      if (ref.realtime === 0) {
        service.off('created', ref.created)
        service.off('updated', ref.updated)
        service.off('patched', ref.patched)
        service.off('removed', ref.removed)
      }
    }
  }, [serviceName])
}
