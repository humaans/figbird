import React, { useState, useMemo, useEffect, useContext, createContext } from 'react'
import { QueryManager } from '../core'

// Create a context for the Figbird state
const FigbirdContext = createContext()

// Custom hook to get the figbird context
export function useFigbird() {
  return useContext(FigbirdContext)
}

// Custom hook to get the feathers client
export function useFeathers() {
  return useContext(FigbirdContext)?.feathers
}

/**
 * Option 1: Default Figbird Provider.
 * Takes a feathers instance as a prop.
 * Will manage the queryManager lifecycle automatically.
 */
export function Provider({
  feathers,
  children,
  idField,
  updatedAtField,
  defaultPageSize,
  defaultPageSizeWhenFetchingAll,
}) {
  const [queryManager] = useState(
    () =>
      new QueryManager({
        feathers,
        idField,
        updatedAtField,
        defaultPageSize,
        defaultPageSizeWhenFetchingAll,
      }),
  )

  // clean up queryManager on unmount
  useEffect(() => () => queryManager.destroy(), [queryManager])

  const figbird = useMemo(() => ({ feathers, queryManager }), [feathers, queryManager])
  return <FigbirdContext.Provider value={figbird}>{children}</FigbirdContext.Provider>
}

/**
 * Option 2: Bespoke Figbird Provider.
 * Takes a custom queryManager instance as a prop
 * and also allows you to inspect its state.
 */
export function createFigbird({
  feathers,
  idField,
  updatedAtField,
  defaultPageSize,
  defaultPageSizeWhenFetchingAll,
}) {
  const queryManager = new QueryManager({
    feathers,
    idField,
    updatedAtField,
    defaultPageSize,
    defaultPageSizeWhenFetchingAll,
  })

  function Provider({ children, ...props }) {
    // clean up queryManager on unmount
    useEffect(() => () => queryManager.destroy(), [queryManager])

    return (
      <FigbirdContext.Provider value={{ feathers, queryManager }} {...props}>
        {children}
      </FigbirdContext.Provider>
    )
  }

  return { queryManager, Provider }
}
