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

  const { skip, ...params } = options

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
    error: null
  })

  useEffect(() => {
    return () => {
      disposed.current = true
    }
  }, [])

  useEffect(() => {
    if (state.fetched) return

    dispatch({ type: 'fetching' })
    const service = feathers.service(serviceName)
    const result = method === 'get' ? service.get(id, params) : service.find(params)

    result.then(updateCache).catch(err => {
      if (!disposed.current) {
        dispatch({ type: 'error', payload: err })
      }
    })
  }, [serviceName, paramsHash, state.fetched])

  // If serviceName or id change, we should refetch the data
  useEffect(() => {
    dispatch({ type: 'refetch' })
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
