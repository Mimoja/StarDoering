import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ActivityWindow from './pages/ActivityWindow'
import './styles.css'

// The log opens in a second BrowserWindow on the same bundle; the hash says which one this is.
const isActivityWindow = window.location.hash.replace(/^#/, '') === 'activity'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isActivityWindow ? <ActivityWindow /> : <App />}</React.StrictMode>
)
