import React, { createContext, useContext, useMemo, useCallback } from 'react'
import { Provider as CacheProvider } from './cache'

export const FigbirdContext = createContext()

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
  const config = useMemo(() => ({ idField, updatedAtField }), [idField, updatedAtField])
  const figbird = useMemo(() => ({ feathers, config }), [feathers, config])

  return (
    <CacheProvider store={store}>
      <FigbirdContext.Provider value={figbird}>{children}</FigbirdContext.Provider>
    </CacheProvider>
  )
}

/** Get the entire figbird context */
export function useFigbird() {
  return useContext(FigbirdContext)
}

/** Get just the feathers client */
export function useFeathers() {
  const { feathers } = useContext(FigbirdContext)
  return feathers
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
