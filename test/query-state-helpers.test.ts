import test from 'ava'
import { isFetching, isIdle, isLoading, isPending } from '../lib'
import type { QueryResult, QueryState } from '../lib'

test('query state helpers identify pending active loading state', t => {
  const query = {
    status: 'loading' as const,
    isFetching: true,
  }

  t.true(isPending(query))
  t.true(isFetching(query))
  t.true(isLoading(query))
  t.false(isIdle(query))
})

test('query state helpers identify pending idle state', t => {
  const query = {
    status: 'loading' as const,
    isFetching: false,
  }

  t.true(isPending(query))
  t.false(isFetching(query))
  t.false(isLoading(query))
  t.true(isIdle(query))
})

test('query state helpers identify successful background fetch state', t => {
  const query = {
    status: 'success' as const,
    isFetching: true,
  }

  t.false(isPending(query))
  t.true(isFetching(query))
  t.false(isLoading(query))
  t.false(isIdle(query))
})

test('query state helpers accept QueryState and QueryResult shapes', t => {
  const state: QueryState<string[]> = {
    status: 'success',
    data: ['hello'],
    meta: {},
    isFetching: false,
    error: null,
  }
  const result: QueryResult<string[]> = {
    status: 'error',
    data: null,
    isFetching: false,
    error: new Error('boom'),
    refetch: () => {},
  }

  t.false(isPending(state))
  t.false(isFetching(state))
  t.false(isLoading(result))
  t.false(isIdle(result))
})
