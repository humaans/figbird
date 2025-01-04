import React, { useState, useMemo, useCallback, useEffect } from 'react'
import { Provider as CacheProvider } from './cache'
import { FigbirdContext } from './context'
import { QueryManager } from '../core'
import { useDispatch } from './cache'
import { useFigbird } from './context'

const defaultIdField = item => item.id || item._id
const defaultUpdatedAtField = item => item.updatedAt || item.updated_at

/**
 * This is the Figbird Provider that at the minimum needs to be passed in a feathers client.
 * Once the app is wrapped in this Provider, all of the figbird hooks can be used.
 */
export const Provider = ({ feathers, store, children, ...props }) => {
  if (!feathers || !feathers.service) {
    throw new Error('Please pass in a feathers client')
  }

  const idField = useIdField(props.idField)
  const updatedAtField = useUpdatedAtField(props.updatedAtField)
  const defaultPageSize = props.defaultPageSize
  const defaultPageSizeWhenFetchingAll = props.defaultPageSizeWhenFetchingAll
  const config = useMemo(
    () => ({ idField, updatedAtField, defaultPageSize, defaultPageSizeWhenFetchingAll }),
    [idField, updatedAtField, defaultPageSize, defaultPageSizeWhenFetchingAll],
  )
  const [queryManager] = useState(() => new QueryManager({ feathers }), [feathers])
  const figbird = useMemo(
    () => ({ feathers, queryManager, config }),
    [feathers, config, queryManager],
  )

  // useEffect(() => () => queryManager.destroy(), [queryManager])

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

function useIdField(idField = defaultIdField) {
  return useCallback(
    item => {
      const id = typeof idField === 'string' ? item[idField] : idField(item)
      if (!id) console.warn('An item has been received without any ID', item)
      return id
    },
    [idField],
  )
}

function useUpdatedAtField(updatedAtField = defaultUpdatedAtField) {
  return useCallback(
    item => {
      return typeof updatedAtField === 'string' ? item[updatedAtField] : updatedAtField(item)
    },
    [updatedAtField],
  )
}
