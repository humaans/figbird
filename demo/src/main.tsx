import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// No FigbirdProvider needed: the hooks exported from ./figbird are bound to the
// instance they were created with. (A provider would override them — the injection
// point for per-request SSR trees and tests.)
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
