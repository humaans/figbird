import { inflight } from './helpers'

const get = inflight((service, id, params, options) => `${service.path}/${options.queryId}`, getter)
const find = inflight((service, params, options) => `${service.path}/${options.queryId}`, finder)

export function fetch(
  feathers,
  serviceName,
  method,
  id,
  params,
  { queryId, allPages, parallel, parallelLimit = 4, transformResponse },
) {
  const service = feathers.service(serviceName)
  const result =
    method === 'get'
      ? get(service, id, params, { queryId })
      : find(service, params, {
          queryId,
          allPages,
          parallel,
          parallelLimit,
        })
  return result.then(transformResponse)
}

function getter(service, id, params) {
  return service.get(id, params)
}

function finder(service, params, { allPages, parallel, parallelLimit }) {
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
      if (
        res.data.length === 0 ||
        res.data.length < res.limit ||
        (isTotalAvailable(res) && result.data.length >= res.total)
      ) {
        resolve(result)
      } else {
        skip = result.data.length
        fetchNext()
      }
    }

    function fetchNextParallel() {
      // If result.total is available, we
      //  - compute total number of pages to fetch
      //  - but limit that to parallelLimit which is 4 by default
      //  - to avoid overloading the server
      // If result.total is not available, we
      //  - optimistically attempt to make more requests that might
      //    be needed
      //  - if all parallel requests return data - good,
      //    we optimised a bit and we keep fetching more
      //  - if all or some parallel requests return blank - it's ok
      //    we accept the trade off of trying to paralellise
      const requiredFetches = Math.min(
        Math.ceil((result.total - result.data.length) / result.limit),
        parallelLimit,
      )

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
      if (typeof result.limit !== 'undefined' && isTotalAvailable(result) && parallel === true) {
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

// allow total to be undefined or -1 to indicate
// that total will not be available on this endpoint
function isTotalAvailable(res) {
  return typeof res.total === 'number' && res.total >= 0
}
