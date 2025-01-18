import React, { useMemo, useEffect, useContext, createContext } from 'react'

const FigbirdContext = createContext()

export function useFigbird() {
  return useContext(FigbirdContext)?.figbird
}

/**
 * @deprecated Will be removed in the future
 */
export function useFeathers() {
  return useContext(FigbirdContext)?.figbird?.adapter.feathers
}

export function Provider({ figbird, children }) {
  const figbird = useMemo(() => ({ figbird }), [figbird])
  return <FigbirdContext.Provider value={figbird}>{children}</FigbirdContext.Provider>
}
