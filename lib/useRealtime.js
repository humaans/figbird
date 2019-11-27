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
    let created, updated, patched, removed

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
      created = entity => actions.feathersCreated({ serviceName, entity })
      updated = entity => actions.feathersUpdated({ serviceName, entity })
      patched = entity => actions.feathersPatched({ serviceName, entity })
      removed = entity => actions.feathersRemoved({ serviceName, entity })

      service.on('created', created)
      service.on('updated', updated)
      service.on('patched', patched)
      service.on('removed', removed)
    }

    return () => {
      // decrement the listener counter
      ref.realtime -= 1

      // unbind from the realtime events if nothing is listening anymore
      if (ref.realtime === 0) {
        service.off('created', created)
        service.off('updated', updated)
        service.off('patched', patched)
        service.off('removed', removed)
      }
    }
  }, [serviceName])
}
