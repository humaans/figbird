/**
 * Example demonstrating combined Figbird and adapter params
 *
 * When using hooks like useFind and useGet, the params parameter accepts BOTH:
 * 1. Figbird-specific params (QueryConfig): skip, realtime, fetchPolicy, allPages, matcher
 * 2. Adapter-specific params (FeathersParams): query, headers, etc.
 */

import type { FeathersClient } from '../../lib'
import { createHooks, createSchema, FeathersAdapter, Figbird, service } from '../../lib'

// Define a model
interface Product {
  id: string
  name: string
  price: number
  category: string
  inStock: boolean
  tags: string[]
}

interface ProductService {
  item: Product
}

// Create schema
const schema = createSchema({
  services: {
    products: service<ProductService>(),
  },
})

// Setup Figbird with FeathersAdapter
const feathersClient = {} as FeathersClient
const adapter = new FeathersAdapter(feathersClient)
const figbird = new Figbird({ adapter, schema })

// Create typed hooks
const { useFind } = createHooks(figbird)

// ✅ EXAMPLE 1: Combining Figbird params with Feathers query
// ✅ EXAMPLE: Complex combination of all param types (kept for test)
export const complexQuery = useFind('products', {
  // FeathersParams
  query: {
    $limit: 25,
    $skip: 50,
    $sort: { createdAt: -1, price: 1 },
    $select: ['id', 'name', 'price', 'category'],
    $or: [
      { category: 'electronics', price: { $lt: 500 } },
      { category: 'books', price: { $lt: 50 } },
    ],
    inStock: true,
  },
  headers: {
    'X-Request-ID': '12345',
  },

  // QueryConfig (Figbird params)
  fetchPolicy: 'cache-first',
  realtime: 'merge',
  allPages: false,
  skip: false,
  matcher: _query => item => {
    // Additional client-side filtering
    return item.tags?.length > 0
  },

  // Custom params (passed through to adapter)
  customParam: 'value',
  anotherCustom: { nested: true },
})

// Type exports to verify combined params work
export type CombinedParamsType = Parameters<typeof useFind<'products'>>[1]

// This should include both QueryConfig and FeathersParams properties
export const testCombinedParams: CombinedParamsType = {
  // QueryConfig properties
  skip: false,
  realtime: 'merge',
  fetchPolicy: 'swr',
  allPages: true,
  matcher: () => () => true,

  // FeathersParams properties
  query: {
    $limit: 10,
    category: 'test',
  },
  headers: {},

  // Custom properties (allowed by both)
  customProperty: 'allowed',
}
