import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Resolve `figbird` and `react-space-router` imports to local sources so HMR picks up
// changes to either library during dev. No build step required.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      figbird: path.resolve(__dirname, '../lib/index.ts'),
      'react-space-router': path.resolve(__dirname, '../../react-space-router/src/index.tsx'),
      'space-router': path.resolve(__dirname, '../../space-router/src/index.ts'),
    },
    // figbird and react-space-router load from sibling repos via aliases. Without dedupe their
    // React resolves to those repos' node_modules while the demo uses demo/node_modules — two
    // copies, broken hooks.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5173,
  },
  optimizeDeps: {
    exclude: ['react-space-router', 'space-router'],
  },
})
