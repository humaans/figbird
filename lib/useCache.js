import { useRef } from 'react'
import { useFigbird } from './core'
import { namespace } from './namespace'
import { getIn } from './helpers'

export function useCache(resourceDescriptor) {
  const { serviceName, params, paramsHash, id, method } = resourceDescriptor
  const { actions, useSelector } = useFigbird()

  // we'll use a cheeky ref to store the previous mapped data array
  // because if the underlying list of data didn't change we don't
  // want consumers of useFind to have to worry about changing reference
  const dataRef = useRef([])

  const cachedData = useSelector(
    state => {
      if (method === 'get') {
        return {
          data: getIn(state, [namespace, 'entities', serviceName, id]) || null,
        }
      }

      let cachedData

      const query = getIn(state, [namespace, 'queries', serviceName, paramsHash])
      if (query) {
        const entities = getIn(state, [namespace, 'entities', serviceName])
        const meta = query.meta
        let data = query.data.map(id => entities[id])

        if (same(dataRef.current, data)) {
          data = dataRef.current
        } else {
          dataRef.current = data
        }

        cachedData = { ...meta, data }
      } else {
        cachedData = { data: null }
      }

      // import to spread the raw data so that tiny-atom doesn't
      // needlessly rerender unless one of the entities inside the
      // array changed
      return { ...cachedData }
    },
    { deps: [serviceName, paramsHash, id, method] }
  )

  const onFetched =
    method === 'get'
      ? entity => actions.feathersFetched({ serviceName, entity })
      : data => actions.feathersFetched({ serviceName, data, params, paramsHash })

  return [cachedData, onFetched]
}

function same(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
