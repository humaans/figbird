import React, { createContext, useContext, useMemo, useCallback } from 'react'
import { useCacheInstance } from './cache'

export const FigbirdContext = createContext()

const defaultIdField = item => item.id || item._id
const defaultUpdatedAtField = item => item.updatedAt || item.updated_at

/**
 * This is the Figbird Provider that at the minimum needs to be passed in a feathers client.
 * Once the app is wrapped in this Provider, all of the figbird hooks will start working!
 */
export const Provider = ({ feathers, children, ...props }) => {
  if (!feathers || !feathers.service) {
    throw new Error('Please pass in a feathers client')
  }

  // there are 2 ways to pass in an existing atom, either via a prop
  // directly or by passing in a custom context
  const { atom: atomFromProps } = props
  const { atom: atomFromContext } = useContext(props.AtomContext || {}) || {}

  const idField = useIdField(props.idField)
  const updatedAtField = useUpdatedAtField(props.updatedAtField)
  const config = useMemo(() => ({ idField, updatedAtField }), [idField, updatedAtField])

  const { atom, AtomProvider, useSelector } = useCacheInstance(
    atomFromProps || atomFromContext,
    config
  )

  // figbird is a catch all context value we use to pass down
  // the feathers api client, the atom instance and the useSelector hook
  // now we have all the pieces in context, the api to fetch data, the atom
  // to store the cache and the selector to efficiently bind to the cache store
  const figbird = useMemo(() => {
    return { feathers, atom, actions: atom.actions, useSelector, config }
  }, [feathers, atom, useSelector, config])

  return (
    <AtomProvider atom={atom}>
      <FigbirdContext.Provider value={figbird}>{children}</FigbirdContext.Provider>
    </AtomProvider>
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
    [idField]
  )
}

function useUpdatedAtField(updatedAtField = defaultUpdatedAtField) {
  return useCallback(
    item => {
      return typeof updatedAtField === 'string' ? item[updatedAtField] : updatedAtField(item)
    },
    [updatedAtField]
  )
}
