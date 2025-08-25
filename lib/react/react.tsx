import type { ReactNode } from 'react'
import React, { createContext, useContext } from 'react'
import type { Adapter } from '../adapters/adapter.js'
import type { Figbird } from '../core/figbird.js'
import type { AnySchema, Schema } from '../core/schema.js'

// Create a generic context factory to maintain type safety
function createFigbirdContext<
  S extends Schema = AnySchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A extends Adapter<any, any, any> = Adapter<
    unknown,
    Record<string, unknown>,
    Record<string, unknown>
  >,
>() {
  return createContext<Figbird<S, A> | undefined>(undefined)
}

// Default context for backward compatibility
const FigbirdContext = createFigbirdContext()

export function useFigbird<
  S extends Schema = AnySchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A extends Adapter<any, any, any> = Adapter<
    unknown,
    Record<string, unknown>,
    Record<string, unknown>
  >,
>(): Figbird<S, A> {
  const context = useContext(FigbirdContext as React.Context<Figbird<S, A> | undefined>)
  if (!context) {
    throw new Error('useFigbird must be used within a FigbirdProvider')
  }
  return context
}

interface FigbirdProviderProps<
  S extends Schema = AnySchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A extends Adapter<any, any, any> = Adapter<
    unknown,
    Record<string, unknown>,
    Record<string, unknown>
  >,
> {
  figbird: Figbird<S, A>
  children: ReactNode
}

export function FigbirdProvider<
  S extends Schema = AnySchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A extends Adapter<any, any, any> = Adapter<
    unknown,
    Record<string, unknown>,
    Record<string, unknown>
  >,
>({ figbird, children }: FigbirdProviderProps<S, A>) {
  // Cast the context to maintain type safety
  const TypedContext = FigbirdContext as React.Context<Figbird<S, A> | undefined>
  return <TypedContext.Provider value={figbird}>{children}</TypedContext.Provider>
}
