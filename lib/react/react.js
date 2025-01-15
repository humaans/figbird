import React, { useMemo, useEffect, useContext, createContext } from 'react'

const FigbirdContext = createContext()

export function useFigbird() {
  return useContext(FigbirdContext)?.figbird
}

export function useFeathers() {
  return useContext(FigbirdContext)?.figbird?.feathers
}

export function Provider({ figbird, children }) {
  const figbird = useMemo(() => ({ figbird }), [figbird])
  return <FigbirdContext.Provider value={figbird}>{children}</FigbirdContext.Provider>
}
