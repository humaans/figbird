/**
 * Real-world example demonstrating typed meta usage with Figbird
 * This shows how pagination metadata flows through the system with full type safety
 */

import type { FeathersClient } from '../../lib'
import { createHooks, createSchema, FeathersAdapter, Figbird, service } from '../../lib'

// Define domain models
interface Article {
  id: string
  title: string
  content: string
  authorId: string
  publishedAt: Date | null
  tags: string[]
}

interface Comment {
  id: string
  articleId: string
  authorId: string
  content: string
  createdAt: Date
}

// Create schema with services
const schema = createSchema({
  services: [service<Article, 'articles'>('articles'), service<Comment, 'comments'>('comments')],
})

// Create Figbird instance with FeathersAdapter
const feathers = {} as FeathersClient
const adapter = new FeathersAdapter(feathers)
const figbird = new Figbird({ schema, adapter })

// Create typed hooks with figbird instance
const { useFind } = createHooks(figbird)

// Example 1: Paginated article list with type-safe metadata
export function ArticleList() {
  const articlesQuery = useFind('articles', {
    query: {
      $limit: 10,
      $skip: 0,
      $sort: { publishedAt: -1 },
    },
  })

  // All these properties are properly typed!
  const { meta } = articlesQuery

  // TypeScript knows meta has FeathersFindMeta properties
  const currentPage = meta.skip && meta.limit ? Math.floor(meta.skip / meta.limit) + 1 : 1
  const totalPages = meta.total && meta.limit ? Math.ceil(meta.total / meta.limit) : 1
  const hasNextPage = meta.total ? (meta.skip || 0) + (meta.limit || 0) < meta.total : false
  const hasPrevPage = (meta.skip || 0) > 0

  // Type-safe pagination info access
  const paginationInfo = {
    currentPage,
    totalPages,
    totalItems: meta.total || 0,
    itemsPerPage: meta.limit || 10,
    startItem: (meta.skip || 0) + 1,
    endItem: Math.min((meta.skip || 0) + (meta.limit || 10), meta.total || 0),
    hasNextPage,
    hasPrevPage,
  }

  return paginationInfo
}

// Example 2: Comment list with infinite scroll
export function CommentList({ articleId }: { articleId: string }) {
  const PAGE_SIZE = 20
  const commentsQuery = useFind('comments', {
    query: {
      articleId,
      $limit: PAGE_SIZE,
      $skip: 0,
      $sort: { createdAt: -1 },
    },
  })

  const { data: comments, meta } = commentsQuery

  // Calculate if there are more comments to load
  const hasMore =
    meta.total !== undefined &&
    meta.skip !== undefined &&
    meta.limit !== undefined &&
    meta.skip + meta.limit < meta.total

  // Calculate loading progress
  const loadedCount = comments?.length || 0
  const totalCount = meta.total || 0
  const loadingProgress = totalCount > 0 ? (loadedCount / totalCount) * 100 : 0

  return {
    comments,
    hasMore,
    loadedCount,
    totalCount,
    loadingProgress,
  }
}

// Example 3: Using meta for displaying table footer
export function ArticleTable() {
  const articlesQuery = useFind('articles', {
    query: {
      $limit: 25,
      $skip: 0,
    },
  })

  const { data: articles, meta, status } = articlesQuery

  // Build footer text with type-safe meta access
  const getFooterText = () => {
    if (status === 'loading') return 'Loading...'
    if (!articles || articles.length === 0) return 'No articles found'

    const start = (meta.skip || 0) + 1
    const end = Math.min((meta.skip || 0) + articles.length, meta.total || articles.length)
    const total = meta.total || articles.length

    return `Showing ${start}-${end} of ${total} articles`
  }

  const footerText = getFooterText()

  // Type-safe calculations for pagination buttons
  const canGoNext =
    meta.total !== undefined &&
    meta.skip !== undefined &&
    meta.limit !== undefined &&
    meta.skip + meta.limit < meta.total

  const canGoPrev = (meta.skip || 0) > 0

  return {
    articles,
    footerText,
    canGoNext,
    canGoPrev,
  }
}

// Example 4: Server-side pagination state management
export function usePaginationState(initialLimit = 10) {
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(initialLimit)

  const skip = (currentPage - 1) * pageSize

  const articlesQuery = useFind('articles', {
    query: {
      $limit: pageSize,
      $skip: skip,
    },
  })

  const { meta } = articlesQuery

  // All these calculations are type-safe!
  const totalPages = meta.total && meta.limit ? Math.ceil(meta.total / meta.limit) : 1

  const isFirstPage = currentPage === 1
  const isLastPage = currentPage >= totalPages

  const goToPage = (page: number) => {
    const validPage = Math.max(1, Math.min(page, totalPages))
    setCurrentPage(validPage)
  }

  const nextPage = () => goToPage(currentPage + 1)
  const prevPage = () => goToPage(currentPage - 1)
  const firstPage = () => goToPage(1)
  const lastPage = () => goToPage(totalPages)

  return {
    currentPage,
    totalPages,
    pageSize,
    totalItems: meta.total || 0,
    isFirstPage,
    isLastPage,
    nextPage,
    prevPage,
    firstPage,
    lastPage,
    setPageSize,
  }
}

// Export types for testing
export type ArticleListMeta = ReturnType<typeof ArticleList>
export type CommentListResult = ReturnType<typeof CommentList>
export type ArticleTableResult = ReturnType<typeof ArticleTable>

// Mock React hooks for the example
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const useState: any
