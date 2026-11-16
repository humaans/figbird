declare const methodType: unique symbol
const queryMarker = Symbol('figbird.query')

type QueryMethod = (...args: never[]) => unknown

/** A runtime read declaration carrying the server method's argument and result types. */
export interface QueryDeclaration<F extends QueryMethod = QueryMethod> {
  readonly [queryMarker]: true
  readonly [methodType]?: F
}

export function query<F extends QueryMethod>(): QueryDeclaration<F> {
  return { [queryMarker]: true }
}

export type QueryDeclarations = Record<string, QueryDeclaration>
export type DeclaredQueries<Q extends QueryDeclarations> = {
  [K in keyof Q]: Q[K] extends QueryDeclaration<infer F> ? F : never
}

export function isQueryDeclaration(value: unknown): value is QueryDeclaration {
  return (
    typeof value === 'object' &&
    value !== null &&
    queryMarker in value &&
    value[queryMarker] === true
  )
}
