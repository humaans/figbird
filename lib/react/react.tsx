import { createContext, ReactNode, useContext } from 'react'
import type { FeathersClient } from '../adapters/feathers-types.js'
import { Figbird } from '../core/figbird.js'
import type { AnySchema, Schema } from '../schema/types.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FigbirdContext = createContext<Figbird<any> | undefined>(undefined)

export function useFigbird<S extends Schema = AnySchema>(): Figbird<S> {
  const context = useContext(FigbirdContext)
  if (!context) {
    throw new Error('useFigbird must be used within a FigbirdProvider')
  }
  return context as Figbird<S>
}

/**
 * Specific to Feathers adapter. Might remove in the future.
 */
export function useFeathers(): FeathersClient | undefined {
  const figbird = useFigbird()
  const adapter = figbird.adapter as { feathers?: FeathersClient }
  return adapter?.feathers
}

interface FigbirdProviderProps<S extends Schema = AnySchema> {
  figbird: Figbird<S>
  children: ReactNode
}

export function FigbirdProvider<S extends Schema = AnySchema>({
  figbird,
  children,
}: FigbirdProviderProps<S>) {
  return <FigbirdContext.Provider value={figbird}>{children}</FigbirdContext.Provider>
}
