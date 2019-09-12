import test from 'ava'
import * as figbird from '../lib'

test('figbird exports', t => {
  t.true(!!figbird.useFind)
  t.true(!!figbird.useGet)
  t.true(!!figbird.useFind)
  t.true(!!figbird.useMutation)
  t.true(!!figbird.Provider)
  t.true(!!figbird.useFigbird)
  t.true(!!figbird.useFeathers)
  t.true(!!figbird.namespace)
})
