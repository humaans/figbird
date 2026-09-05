import { availableParallelism } from 'node:os'

export default {
  concurrency: availableParallelism(),
  files: ['test/*.test.{js,ts,tsx}'],
  extensions: ['js', 'ts', 'tsx'],
  nodeArguments: ['--import=@swc-node/register/esm-register'],
  require: ['./test/setup.ts'],
}
