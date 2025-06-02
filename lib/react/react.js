import React, { useContext, createContext } from 'react'

const FigbirdContext = createContext()

export function useFigbird() {
  return useContext(FigbirdContext)
}

/**
 * Specific to Feathers adapter. Might remove in the future.
 */
export function useFeathers() {
  return useContext(FigbirdContext)?.adapter.feathers
}

export function Provider({ figbird, children }) {
  return <FigbirdContext.Provider value={figbird}>{children}</FigbirdContext.Provider>
}
