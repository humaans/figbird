import React, { useContext, createContext, ReactNode } from 'react'
import type { Figbird } from '../core/figbird'
import type { Schema } from '../core/schema'

const FigbirdContext = createContext<Figbird<any> | undefined>(undefined)

export function useFigbird<S extends Schema<any>>() {
  return useContext(FigbirdContext as unknown as React.Context<Figbird<S>>)
}

/**
 * @returns An adapter specific helper, might remove in the future
 */
export function useFeathers() {
  return (useContext(FigbirdContext)?.adapter as any).feathers
}

interface ProviderProps<S extends Schema<any>> {
  figbird: Figbird<S>
  children: ReactNode
}

export function Provider<S extends Schema<any>>({ figbird, children }: ProviderProps<S>) {
  return (
    <FigbirdContext.Provider value={figbird as Figbird<any>}>{children}</FigbirdContext.Provider>
  )
}
