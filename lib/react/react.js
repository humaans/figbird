import React, { useContext, createContext } from 'react'

const FigbirdContext = createContext()

export function useFigbird() {
  return useContext(FigbirdContext)
}

/**
 * @deprecated Will be removed in the future
 */
export function useFeathers() {
  return useContext(FigbirdContext)?.adapter.feathers
}

export function Provider({ figbird, children }) {
  return <FigbirdContext.Provider value={figbird}>{children}</FigbirdContext.Provider>
}
