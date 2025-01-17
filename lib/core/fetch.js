export function fetch(
  feathers,
  { serviceName, method, resourceId, params, allPages, parallel, parallelLimit = 4 },
) {
  const service = feathers.service(serviceName)
  const result =
    method === 'get'
      ? get(service, resourceId, params)
      : find(service, params, { allPages, parallel, parallelLimit })
  return result
}

function get(service, resourceId, params) {
  return service.get(resourceId, params)
}

function find(service, params, { allPages, parallel, parallelLimit }) {
  if (!allPages) {
    return service.find(params)
  } else {
    return findAll(service, params, { parallel, parallelLimit })
  }
}

function findAll(service, params, { parallel, parallelLimit }) {
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
      //  - compute total number of pages to fetch
      //  - but limit that to parallelLimit which is 4 by default
      //  - to avoid overloading the server
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
