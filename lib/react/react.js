import React, { useState, useMemo, useEffect, useContext, createContext } from 'react'
import { QueryManager } from '../core'
import { Provider as CacheProvider, useDispatch } from './cache'

export const FigbirdContext = createContext()

/**
 * This is the Figbird Provider that at the minimum needs to be passed in a feathers client.
 * Once the app is wrapped in this Provider, all of the figbird hooks can be used.
 */
export const Provider = ({
  feathers,
  store,
  queryManager,
  idField,
  updatedAtField,
  defaultPageSize,
  defaultPageSizeWhenFetchingAll,
  children,
}) => {
  const [queryManager] = useState(
    () =>
      queryManager ||
      new QueryManager({
        feathers,
        idField,
        updatedAtField,
        defaultPageSize,
        defaultPageSizeWhenFetchingAll,
      }),
    [
      feathers,
      idField,
      updatedAtField,
      defaultPageSize,
      defaultPageSizeWhenFetchingAll,
      queryManager,
    ],
  )
  const figbird = useMemo(() => ({ feathers, queryManager }), [feathers, queryManager])

  useEffect(() => () => queryManager.destroy(), [queryManager])

  return (
    <CacheProvider store={store}>
      <FigbirdContext.Provider value={figbird}>
        <SyncCache>{children}</SyncCache>
      </FigbirdContext.Provider>
    </CacheProvider>
  )
}

function SyncCache({ children }) {
  const dispatch = useDispatch()
  const { queryManager } = useFigbird()

  useEffect(() => {
    return queryManager.subscribe(state => {
      dispatch(state)
    })
  }, [])

  return children
}

/** Get the entire figbird context */
export function useFigbird() {
  return useContext(FigbirdContext)
}

/** Get the feathers client */
export function useFeathers() {
  return useContext(FigbirdContext).feathers
}
