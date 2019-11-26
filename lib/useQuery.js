import { useReducer, useEffect, useRef } from 'react'
import { useFigbird } from './core'
import { useRealtime } from './useRealtime'
import { useCache } from './useCache'
import { hashObject } from './helpers'

/**
 * A generic abstraction of both get and find
 */
export function useQuery(serviceName, options = {}, queryHookOptions = {}) {
  const { method, id } = queryHookOptions

  const { feathers } = useFigbird()
  const disposed = useRef(false)

  const { skip, allPages, ...params } = options

  const paramsHash = hashObject(params)

  const [cachedData, updateCache] = useCache({
    serviceName,
    params,
    paramsHash,
    id,
    method
  })

  const hasCachedData = !!cachedData.data

  const [state, dispatch] = useReducer(reducer, {
    loading: !hasCachedData && !skip,
    reloading: hasCachedData && !skip,
    hasCachedData: hasCachedData,
    fetched: false,
    refetchSeq: 0,
    error: null
  })

  useEffect(() => {
    return () => {
      disposed.current = true
    }
  }, [])

  useEffect(() => {
    if (state.fetched) return
    if (skip) return

    dispatch({ type: 'fetching' })
    const service = feathers.service(serviceName)
    const result = method === 'get' ? service.get(id, params) : find(service, params, { allPages })

    result.then(updateCache).catch(err => {
      if (!disposed.current) {
        dispatch({ type: 'error', payload: err })
      }
    })
  }, [serviceName, paramsHash, state.fetched, state.refetchSeq, skip, allPages])

  // If serviceName or id change, we should refetch the data
  useEffect(() => {
    dispatch({ type: 'reset' })
  }, [serviceName, paramsHash])

  // once the data is placed into cache and we've received it at this end
  // mark the local state as success and also note down the cache status
  useEffect(() => {
    if (hasCachedData) {
      dispatch({ type: 'success' })
    }
    dispatch({ type: 'updateHasCachedData', hasCachedData })
  }, [hasCachedData])

  // realtime hook will make sure we're listening to all of the
  // updates to this service
  useRealtime(serviceName)

  return {
    ...cachedData,
    refetch: () => dispatch({ type: 'refetch' }),
    loading: state.loading,
    reloading: state.reloading,
    error: state.error
  }
}

function reducer(state, action) {
  switch (action.type) {
    case 'fetching':
      return {
        ...state,
        loading: !state.hasCachedData,
        reloading: state.hasCachedData,
        error: null
      }
    case 'success':
      return { ...state, loading: false, fetched: true, reloading: false }
    case 'error':
      return {
        ...state,
        loading: false,
        reloading: false,
        fetched: true,
        error: action.payload
      }
    case 'refetch':
      return {
        ...state,
        fetched: false,
        refetchSeq: state.refetchSeq + 1
      }
    case 'reset':
      if (!state.fetched) {
        return state
      } else {
        return {
          ...state,
          fetched: false
        }
      }
    case 'updateHasCachedData':
      if (state.hasCachedData === action.hasCachedData) {
        return state
      } else {
        return {
          ...state,
          hasCachedData: action.hasCachedData
        }
      }
    default:
      throw new Error()
  }
}

function find(service, params, { allPages }) {
  if (!allPages) {
    return service.find(params)
  }

  return new Promise((resolve, reject) => {
    let skip = 0
    const result = { data: [], skip: 0 }

    fetchNext()

    function fetchNext() {
      service
        .find({
          ...params,
          query: {
            ...(params.query || {}),
            $skip: skip
          }
        })
        .then(res => {
          result.limit = res.limit
          result.total = res.total
          result.data = result.data.concat(res.data)

          if (res.data.length === 0 || result.data.length >= result.total) {
            resolve(result)
          } else {
            skip = res.skip + res.limit
            fetchNext()
          }
        })
        .catch(reject)
    }
  })
}
