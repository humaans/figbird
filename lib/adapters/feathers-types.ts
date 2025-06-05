// Feathers-specific types for the Feathers adapter

/**
 * Feathers query parameters
 */
export interface FeathersQuery {
  $limit?: number
  $skip?: number
  $sort?: Record<string, 1 | -1>
  $select?: string[]
  $or?: Array<Record<string, unknown>>
  $and?: Array<Record<string, unknown>>
  [key: string]: unknown
}

/**
 * Feathers service method parameters
 */
export interface FeathersParams {
  query?: FeathersQuery
  paginate?: boolean | { default?: boolean; max?: number }
  provider?: string
  route?: Record<string, string>
  connection?: unknown
  headers?: Record<string, string>
  [key: string]: unknown
}

/**
 * Feathers-specific metadata for find operations
 */
export interface FeathersFindMeta {
  total?: number
  limit?: number
  skip?: number
  [key: string]: unknown
}

/**
 * Feathers item with standard id fields
 */
export interface FeathersItem {
  id?: string | number
  _id?: string | number
  [key: string]: unknown
}

/**
 * Feathers item with timestamp fields
 */
export interface TimestampedItem extends FeathersItem {
  updatedAt?: string | Date | number
  updated_at?: string | Date | number
  createdAt?: string | Date | number
  created_at?: string | Date | number
}

/**
 * Feathers service interface
 */
export interface FeathersService<T = FeathersItem> {
  get(id: string | number, params?: FeathersParams): Promise<T>
  find(
    params?: FeathersParams,
  ): Promise<{ data: T[]; total?: number; limit?: number; skip?: number } | T[]>
  create(data: Partial<T>, params?: FeathersParams): Promise<T>
  update(id: string | number, data: Partial<T>, params?: FeathersParams): Promise<T>
  patch(id: string | number, data: Partial<T>, params?: FeathersParams): Promise<T>
  remove(id: string | number, params?: FeathersParams): Promise<T>
  on(event: string, listener: (data: T) => void): void
  off(event: string, listener: (data: T) => void): void
  [method: string]: unknown
}

/**
 * Feathers client interface
 */
export interface FeathersClient {
  service(name: string): FeathersService
}
