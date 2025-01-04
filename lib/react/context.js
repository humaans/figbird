import { createContext, useContext } from 'react'

export const FigbirdContext = createContext()

/** Get the entire figbird context */
export function useFigbird() {
  return useContext(FigbirdContext)
}

/** Get the feathers client */
export function useFeathers() {
  return useContext(FigbirdContext).feathers
}
