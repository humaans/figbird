import { useQuery } from './useQuery'

export function useGet(serviceName, id, options = {}) {
  return useQuery(serviceName, options, { method: 'get', id })
}
