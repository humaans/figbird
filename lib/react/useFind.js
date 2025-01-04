import { useQuery } from './useQuery'

const selectData = data => data
const transformResponse = data => data

export function useFind(serviceName, options = {}) {
  return useQuery(serviceName, options, { method: 'find', selectData, transformResponse })
}
