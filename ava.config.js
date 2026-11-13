import { availableParallelism } from 'node:os'

export default {
  concurrency: availableParallelism(),
  files: ['test/*.test.{js,ts,tsx}'],
  extensions: ['js', 'ts', 'tsx'],
  nodeArguments: ['--import=tsx'],
  require: ['./test/setup.ts'],
}
