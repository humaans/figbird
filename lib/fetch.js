import { inflight } from './helpers'

const get = inflight((service, id, params, options) => `${service.path}/${options.queryId}`, getter)
const find = inflight((service, params, options) => `${service.path}/${options.queryId}`, finder)

export function fetch(
  feathers,
  serviceName,
  method,
  id,
  params,
  { queryId, allPages, parallel, transformResponse },
) {
  const service = feathers.service(serviceName)
  const result =
    method === 'get'
      ? get(service, id, params, { queryId })
      : find(service, params, { queryId, allPages, parallel })
  return result.then(transformResponse)
}

function getter(service, id, params) {
  return service.get(id, params)
}

function finder(service, params, { queryId, allPages, parallel }) {
  if (!allPages) {
    return service.find(params)
  }

  return new Promise((resolve, reject) => {
    let skip = 0
    const result = { data: [], skip: 0 }

    fetchNext()

    function doFind(skip) {
      return service.find({
        ...params,
        query: {
          ...(params.query || {}),
          $skip: skip,
        },
      })
    }

    function resolveOrFetchNext(res) {
      if (res.data.length === 0 || result.data.length >= result.total) {
        resolve(result)
      } else {
        skip = result.data.length
        fetchNext()
      }
    }

    function fetchNextParallel() {
      const requiredFetches = Math.ceil((result.total - result.data.length) / result.limit)

      if (requiredFetches > 0) {
        Promise.all(
          new Array(requiredFetches).fill().map((_, idx) => doFind(skip + idx * result.limit)),
        )
          .then(results => {
            const [lastResult] = results.slice(-1)
            result.limit = lastResult.limit
            result.total = lastResult.total
            result.data = result.data.concat(results.flatMap(r => r.data))

            resolveOrFetchNext(lastResult)
          })
          .catch(reject)
      } else {
        resolve(result)
      }
    }

    function fetchNext() {
      if (
        typeof result.total !== 'undefined' &&
        typeof result.limit !== 'undefined' &&
        parallel === true
      ) {
        fetchNextParallel()
      } else {
        doFind(skip)
          .then(res => {
            result.limit = res.limit
            result.total = res.total
            result.data = result.data.concat(res.data)

            resolveOrFetchNext(res)
          })
          .catch(reject)
      }
    }
  })
}
