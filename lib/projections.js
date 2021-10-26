import { useEffect, useRef } from 'react'
import { useFigbird } from './core'
import { namespace } from './namespace'
import { getIn, same } from './helpers'

const projections = new Map()

const identity = x => x

export function projection() {
  return {}
}

export function useProjection(projection, mapping) {
  useEffect(() => {
    projections.set(projection, mapping)
    return () => {
      projections.delete(projection)
    }
  }, [projection, mapping])

  return useProjectionValue(projection)
}

export function useProjectionValue(projection, selector = identity, deps = []) {
  projection = projections.get(projection) || {}

  // we could just use the mapping reference, but that's not currently
  // memoized anywhere, so we opt for hashing the mapping keys/values for now
  const projectionId = Object.entries(projection)
    .map(([k, v]) => `${k}=${v}`)
    .join(':')

  // we'll use a cheeky ref to store the previous mapped data array
  // because if the underlying list of data didn't change we don't
  // want consumers of useProjectionValue to have to worry about changing
  // reference
  const dataRef = useRef({})

  const { useSelector } = useFigbird()

  const cachedData = useSelector(
    state => {
      const projectionErrors = []
      const statuses = []

      // create a slice of the whole figbird cache
      // that pertains to this specific projection
      const slice = {}
      for (const [key, queryId] of Object.entries(projection)) {
        if (!dataRef.current[key]) {
          dataRef.current[key] = { current: [] }
        }
        const result = getQueryData(state, queryId, dataRef.current[key])

        // TODO - reuse from useQuery and correct the implementation
        const skip = false
        const hasCachedData = !!result.data
        const loading = !skip && !hasCachedData && !result.error
        const status = loading ? 'loading' : result.error ? 'error' : 'success'

        slice[key] = { ...result, status }

        if (status === 'error') {
          projectionErrors.push(result.error)
        }

        statuses.push(status)
      }

      let projectionStatus
      if (statuses.length && statuses.every(s => s === 'success')) {
        projectionStatus = 'success'
      } else if (statuses.length && statuses.some(s => s === 'error')) {
        projectionStatus = 'error'
      } else {
        projectionStatus = 'loading'
      }

      return {
        data: selector(slice),
        status: projectionStatus,
        error: projectionErrors[0],
        projectionErrors,
      }
    },
    { deps: [projectionId, ...deps] }
  )

  return cachedData
}

function getQueryData(state, queryId, dataRef) {
  const [serviceName] = queryId.split(':')
  const query = getIn(state, [namespace, 'queries', serviceName, queryId])
  if (query) {
    let { data, meta } = query
    const entities = query.entities || getIn(state, [namespace, 'entities', serviceName])
    data = data.map(id => entities[id])
    if (same(data, dataRef.current)) {
      data = dataRef.current
    } else {
      dataRef.current = data
    }
    // TODO: add support for get in addition to find,
    // for that we need to pass this selectData helper
    // through or similar
    // data = selectData(data)
    return { ...meta, data }
  } else {
    return { data: null }
  }
}
