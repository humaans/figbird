import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FigbirdProvider } from 'figbird'
import { App } from './App'
import { figbird } from './figbird'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FigbirdProvider figbird={figbird}>
      <App />
    </FigbirdProvider>
  </StrictMode>,
)
