import { useQuery } from './useQuery'

const selectData = data => data[0]
const transformResponse = data => ({ data: [data] })

export function useGet(serviceName, id, options = {}) {
  return useQuery(serviceName, options, { method: 'get', id, selectData, transformResponse })
}
