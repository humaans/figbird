import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Resolve `figbird` to local sources so HMR picks up library changes during dev.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'figbird/devtools': path.resolve(__dirname, '../lib/devtools.ts'),
      figbird: path.resolve(__dirname, '../lib/index.ts'),
    },
    // figbird loads from the parent repo. Dedupe React so hooks use the demo's copy.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5173,
  },
})
