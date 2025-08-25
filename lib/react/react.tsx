import type { ReactNode } from 'react'
import React, { createContext, useContext } from 'react'
import type { Figbird } from '../core/figbird.js'
import type { AnySchema, Schema } from '../schema/types.js'

// Create a generic context factory to maintain type safety
function createFigbirdContext<S extends Schema = AnySchema>() {
  return createContext<Figbird<S> | undefined>(undefined)
}

// Default context for backward compatibility
const FigbirdContext = createFigbirdContext()

export function useFigbird<S extends Schema = AnySchema>(): Figbird<S> {
  const context = useContext(FigbirdContext as React.Context<Figbird<S> | undefined>)
  if (!context) {
    throw new Error('useFigbird must be used within a FigbirdProvider')
  }
  return context
}

interface FigbirdProviderProps<S extends Schema = AnySchema> {
  figbird: Figbird<S>
  children: ReactNode
}

export function FigbirdProvider<S extends Schema = AnySchema>({
  figbird,
  children,
}: FigbirdProviderProps<S>) {
  // Cast the context to maintain type safety
  const TypedContext = FigbirdContext as React.Context<Figbird<S> | undefined>
  return <TypedContext.Provider value={figbird}>{children}</TypedContext.Provider>
}
