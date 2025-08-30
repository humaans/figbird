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
const { useFind, useGet } = createHooks(figbird)

// ✅ EXAMPLE 1: Combining Figbird params with Feathers query
export const productsWithCombinedParams = useFind('products', {
  // FeathersParams properties
  query: {
    $limit: 10,
    $skip: 0,
    $sort: { price: -1 },
    category: 'electronics',
    inStock: true,
  },
  headers: {
    Authorization: 'Bearer token',
  },

  // Figbird QueryConfig properties
  fetchPolicy: 'cache-first', // Figbird-specific: caching strategy
  realtime: 'merge', // Figbird-specific: realtime update strategy
})

// ✅ EXAMPLE 2: Using skip (Figbird param) with query (Feathers param)
export function ConditionalProducts({ enabled }: { enabled: boolean }) {
  const products = useFind('products', {
    // Feathers query
    query: {
      inStock: true,
      $limit: 20,
    },

    // Figbird param - skip the query if not enabled
    skip: !enabled,
  })

  return products
}

// ✅ EXAMPLE 3: Using allPages (Figbird) with pagination (Feathers)
export const allProducts = useFind('products', {
  // Feathers params
  query: {
    $limit: 5, // Fetch 5 items per page
    category: 'books',
  },

  // Figbird param - automatically fetch all pages
  allPages: true,
})

// ✅ EXAMPLE 4: Custom matcher (Figbird) with Feathers query
export const filteredProducts = useFind('products', {
  // Feathers query for initial fetch
  query: {
    category: 'electronics',
    $sort: { price: 1 },
  },

  // Figbird custom matcher for realtime filtering
  matcher: _query => item => {
    // Custom logic beyond standard Feathers query
    return item.price > 100 && item.tags?.includes('premium')
  },

  // Figbird realtime strategy
  realtime: 'merge',
})

// ✅ EXAMPLE 5: Different fetch policies with the same query
export function ProductListWithPolicies() {
  // Stale-while-revalidate: show cached data immediately, refetch in background
  const swrProducts = useFind('products', {
    query: { category: 'toys', $limit: 10 },
    fetchPolicy: 'swr',
  })

  // Cache first: only fetch if not in cache
  const cachedProducts = useFind('products', {
    query: { category: 'toys', $limit: 10 },
    fetchPolicy: 'cache-first',
  })

  // Network only: always fetch fresh data, no caching
  const freshProducts = useFind('products', {
    query: { category: 'toys', $limit: 10 },
    fetchPolicy: 'network-only',
  })

  return { swrProducts, cachedProducts, freshProducts }
}

// ✅ EXAMPLE 6: Realtime strategies with Feathers params
export function RealtimeProducts() {
  // Merge: incorporate realtime updates into cached data
  const mergeProducts = useFind('products', {
    query: { inStock: true },
    realtime: 'merge', // Figbird param for merge strategy
  })

  // Refetch: refetch entire query on any realtime event
  const refetchProducts = useFind('products', {
    query: { inStock: true },
    realtime: 'refetch',
  })

  // Disabled: no realtime updates
  const staticProducts = useFind('products', {
    query: { inStock: true },
    realtime: 'disabled',
  })

  return { mergeProducts, refetchProducts, staticProducts }
}

// ✅ EXAMPLE 7: useGet with combined params
export const singleProduct = useGet('products', 'product-123', {
  // Feathers params
  query: {
    $select: ['id', 'name', 'price'], // Only fetch specific fields
  },

  // Figbird params
  fetchPolicy: 'swr',
  skip: false,
})

// ✅ EXAMPLE 8: Complex combination of all param types
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

// Function showing runtime behavior
export function demonstrateSplitConfig() {
  // When this is called, splitConfig will separate:
  // - QueryConfig props (skip, realtime, etc.) into config
  // - Everything else (query, etc.) into params
  const result = useFind('products', {
    // These go to QueryConfig
    skip: false,
    fetchPolicy: 'swr',
    realtime: 'merge',

    // These go to adapter params
    query: { category: 'electronics' },
    customField: 'value',
  })

  return result
}
