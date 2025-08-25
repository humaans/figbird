import type { ReactNode } from 'react'
import React, { createContext, useContext } from 'react'
import type { Figbird } from '../core/figbird.js'
import type { AnySchema, Schema } from '../core/schema.js'

// Create a generic context factory to maintain type safety
function createFigbirdContext<
  S extends Schema = AnySchema,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
>() {
  return createContext<Figbird<S, TMeta> | undefined>(undefined)
}

// Default context for backward compatibility
const FigbirdContext = createFigbirdContext()

export function useFigbird<
  S extends Schema = AnySchema,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
>(): Figbird<S, TMeta> {
  const context = useContext(FigbirdContext as React.Context<Figbird<S, TMeta> | undefined>)
  if (!context) {
    throw new Error('useFigbird must be used within a FigbirdProvider')
  }
  return context
}

interface FigbirdProviderProps<
  S extends Schema = AnySchema,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  figbird: Figbird<S, TMeta>
  children: ReactNode
}

export function FigbirdProvider<
  S extends Schema = AnySchema,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
>({ figbird, children }: FigbirdProviderProps<S, TMeta>) {
  // Cast the context to maintain type safety
  const TypedContext = FigbirdContext as React.Context<Figbird<S, TMeta> | undefined>
  return <TypedContext.Provider value={figbird}>{children}</TypedContext.Provider>
}
