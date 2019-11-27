import { useReducer, useEffect, useRef } from 'react'
import { useFigbird } from './core'
import { useRealtime } from './useRealtime'
import { useCache } from './useCache'
import { hashObject } from './helpers'

const get = inflight((service, id, params) => `${service.path}/${id}`, getter)
const find = inflight((service, params, options) => `${service.path}/${options.paramsHash}`, finder)

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
    reloading: false,
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
    let disposed = false

    if (state.fetched) return
    if (skip) return

    dispatch({ type: 'fetching' })
    const service = feathers.service(serviceName)
    const result =
      method === 'get' ? get(service, id, params) : find(service, params, { paramsHash, allPages })

    result
      .then(res => {
        // no res means we've piggy backed on an in flight request
        if (res) {
          updateCache(res)
        }

        if (!disposed) {
          dispatch({ type: 'success' })
        }
      })
      .catch(err => {
        if (!disposed.current) {
          dispatch({ type: 'error', payload: err })
        }
      })

    return () => {
      disposed = true
    }
  }, [serviceName, paramsHash, state.fetched, state.refetchSeq, skip, allPages])

  // If serviceName or id change, we should refetch the data
  useEffect(() => {
    dispatch({ type: 'reset' })
  }, [serviceName, paramsHash])

  // once the data is placed into cache and we've received it at this end
  // mark the local state as success and also note down the cache status
  useEffect(() => {
    dispatch({ type: 'updateHasCachedData', hasCachedData })
  }, [hasCachedData])

  // realtime hook will make sure we're listening to all of the
  // updates to this service
  useRealtime(serviceName)

  // derive the loading/reloading state from other substates
  const loading = !skip && !hasCachedData && !state.error
  const reloading = loading || state.reloading

  return {
    ...cachedData,
    refetch: () => dispatch({ type: 'refetch' }),
    loading,
    reloading,
    error: state.error
  }
}

function reducer(state, action) {
  switch (action.type) {
    case 'fetching':
      return {
        ...state,
        reloading: true,
        error: null
      }
    case 'success':
      return { ...state, fetched: true, reloading: false }
    case 'error':
      return {
        ...state,
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
  }
}

function getter(service, id, params) {
  return service.get(id, params)
}

function finder(service, params, { paramsHash, allPages }) {
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

function inflight(makeKey, fn) {
  const flying = {}

  return (...args) => {
    const key = makeKey(...args)

    if (flying[key]) {
      return flying[key].then(() => null)
    }

    const res = fn(...args)
    flying[key] = res
      .then(res => {
        delete flying[key]
        return res
      })
      .catch(err => {
        delete flying[key]
        throw err
      })

    return res
  }
}
