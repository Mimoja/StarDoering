import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ActivityWindow from './pages/ActivityWindow'
import Updating from './pages/Updating'
import { api } from './lib/hooks'
import './styles.css'

// The log opens in a second BrowserWindow on the same bundle; the hash says which one this is.
const isActivityWindow = window.location.hash.replace(/^#/, '') === 'activity'

// The main window shows the start-up updater until the main process lets the app view render (nothing before the
// first answer, so the app never mounts early and a dev run does not flash the updater line).
function Main() {
  const [gate, setGate] = useState<boolean | null>(null)
  useEffect(() => {
    void api.update
      .state()
      .then((s) => setGate(s.gate))
      .catch(() => setGate(false))
    return api.update.onState((s) => setGate(s.gate))
  }, [])
  if (gate == null) return null
  return gate ? <Updating /> : <App />
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{isActivityWindow ? <ActivityWindow /> : <Main />}</React.StrictMode>)
