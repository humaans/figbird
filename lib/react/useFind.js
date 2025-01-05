import { useQuery } from './useQuery'

export function useFind(serviceName, options = {}) {
  return useQuery(serviceName, options, { method: 'find' })
}
