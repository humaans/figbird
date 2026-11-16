import type { QueryBuilder } from './queryBuilder.js'
import type { Schema } from './schema.js'

// The type check makes adding a builder member require updating its runtime reservation.
const members = {
  hash: true,
  toAST: true,
  where: true,
  orderBy: true,
  limit: true,
  skip: true,
  server: true,
  snapshot: true,
  get: true,
  paginate: true,
  all: true,
  related: true,
} satisfies Record<keyof QueryBuilder<Schema> & string, true>

/** Names a custom query cannot take, because the builder proxy resolves them first. */
export type ReservedQueryName =
  | keyof typeof members
  // oxlint-disable-next-line @typescript-eslint/no-wrapper-object-types -- the members every object inherits
  | (keyof Object & string)
  | 'then'
  | 'toJSON'

export function isQueryBuilderMember(name: string): boolean {
  return (
    Object.hasOwn(members, name) || name in Object.prototype || name === 'then' || name === 'toJSON'
  )
}
