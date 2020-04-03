import { useEffect } from 'react'
import { useFigbird } from './core'
import { namespace } from './namespace'
import { getIn } from './helpers'

/**
 * An internal hook that will listen to realtime updates to a service
 * and update the cache as changes happen.
 */
export function useRealtime(serviceName, mode, cb) {
  const { feathers, atom, actions } = useFigbird()

  useEffect(() => {
    // realtime is turned off
    if (!mode) return

    // get the ref store of this service
    const refs = getIn(atom.get(), [namespace, 'refs'])
    refs[serviceName] = refs[serviceName] || {}
    refs[serviceName].realtime = refs[serviceName].realtime || 0
    refs[serviceName].callbacks = refs[serviceName].callbacks || []
    const ref = refs[serviceName]

    if (mode === 'refetch' && cb) {
      refs[serviceName].callbacks.push(cb)
    }

    // get the service itself
    const service = feathers.service(serviceName)

    // increment the listener counter
    ref.realtime += 1

    // bind to the realtime events, but only once globally per service
    if (ref.realtime === 1) {
      ref.created = item => {
        actions.feathersCreated({ serviceName, item })
        refs[serviceName].callbacks.forEach(c => c({ event: 'created', serviceName, item }))
      }
      ref.updated = item => {
        actions.feathersUpdated({ serviceName, item })
        refs[serviceName].callbacks.forEach(c => c({ event: 'updated', serviceName, item }))
      }
      ref.patched = item => {
        actions.feathersPatched({ serviceName, item })
        refs[serviceName].callbacks.forEach(c => c({ event: 'patched', serviceName, item }))
      }
      ref.removed = item => {
        actions.feathersRemoved({ serviceName, item })
        refs[serviceName].callbacks.forEach(c => c({ event: 'removed', serviceName, item }))
      }

      service.on('created', ref.created)
      service.on('updated', ref.updated)
      service.on('patched', ref.patched)
      service.on('removed', ref.removed)
    }

    return () => {
      // decrement the listener counter
      ref.realtime -= 1
      refs[serviceName].callbacks = refs[serviceName].callbacks.filter(c => c !== cb)

      // unbind from the realtime events if nothing is listening anymore
      if (ref.realtime === 0) {
        service.off('created', ref.created)
        service.off('updated', ref.updated)
        service.off('patched', ref.patched)
        service.off('removed', ref.removed)
      }
    }
  }, [serviceName, mode, cb])
}
