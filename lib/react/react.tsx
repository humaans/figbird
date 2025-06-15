import { useContext, createContext, ReactNode } from 'react'
import { Figbird } from '../core/figbird.js'
import type { FeathersClient } from '../adapters/feathers-types.js'

const FigbirdContext = createContext<Figbird | undefined>(undefined)

export function useFigbird(): Figbird {
  const context = useContext(FigbirdContext)
  if (!context) {
    throw new Error('useFigbird must be used within a FigbirdProvider')
  }
  return context
}

/**
 * Specific to Feathers adapter. Might remove in the future.
 */
export function useFeathers(): FeathersClient | undefined {
  const figbird = useFigbird()
  const adapter = figbird.adapter as { feathers?: FeathersClient }
  return adapter?.feathers
}

interface FigbirdProviderProps {
  figbird: Figbird
  children: ReactNode
}

export function FigbirdProvider({ figbird, children }: FigbirdProviderProps) {
  return <FigbirdContext.Provider value={figbird}>{children}</FigbirdContext.Provider>
}
