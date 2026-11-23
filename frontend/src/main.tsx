import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import DemoSession from './DemoSession.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DemoSession />
  </StrictMode>,
)
