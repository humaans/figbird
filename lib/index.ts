// core
export { Figbird } from './core/figbird.js'

// adapters
export { FeathersAdapter } from './adapters/feathers.js'
export { matcher } from './adapters/matcher.js'

// react hooks
export { useGet, useFind } from './react/useQuery.js'
export { useMutation } from './react/useMutation.js'
export { Provider, useFigbird, useFeathers } from './react/react.js'