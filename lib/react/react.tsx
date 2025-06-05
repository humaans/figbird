import { useContext, createContext, ReactNode } from 'react'
import { Figbird } from '../core/figbird.js'

// Type for the Feathers client object
interface FeathersClientLike {
  service(name: string): unknown
  [key: string]: unknown
}

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
export function useFeathers(): FeathersClientLike | undefined {
  const figbird = useFigbird()
  const adapter = figbird.adapter as { feathers?: FeathersClientLike }
  return adapter?.feathers
}

interface ProviderProps {
  figbird: Figbird
  children: ReactNode
}

export function Provider({ figbird, children }: ProviderProps) {
  return <FigbirdContext.Provider value={figbird}>{children}</FigbirdContext.Provider>
}
