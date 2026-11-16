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

export function isQueryBuilderMember(name: string): boolean {
  return (
    Object.hasOwn(members, name) || name in Object.prototype || name === 'then' || name === 'toJSON'
  )
}
