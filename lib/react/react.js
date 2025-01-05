import React, { useState, useMemo, useCallback, useEffect } from 'react'
import { Provider as CacheProvider } from './cache'
import { FigbirdContext } from './context'
import { QueryManager } from '../core'
import { useDispatch } from './cache'
import { useFigbird } from './context'

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
