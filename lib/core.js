import React, { createContext, useContext, useMemo } from 'react'
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
  // directly or by passing
  const { atom: atomFromProps } = props
  const { atom: atomFromContext } = useContext(props.AtomContext || {}) || {}

  const idField = props.idField || defaultIdField
  const updatedAtField = props.updatedAtField || defaultUpdatedAtField
  const config = useMemo(() => {
    return {
      idField: typeof idField === 'string' ? item => item[idField] : idField,
      updatedAtField:
        typeof updatedAtField === 'string' ? item => item[updatedAtField] : updatedAtField
    }
  }, [idField, updatedAtField])

  // First of all, when we first render this app, create a bunch of localised
  // tiny-atom context separate from the main tiny-atom context. This will allow
  // us to store cache data in either the provided atom or one we create ourselves
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
