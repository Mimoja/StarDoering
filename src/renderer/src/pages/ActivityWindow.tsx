import { useEffect, useState } from 'react'
import ActivityLog from '../components/ActivityLog'

// The separate log window (index.html#activity): the sidebar's ActivityLog given the whole window, with its own toast
// because the app shell is not around it.
export default function ActivityWindow() {
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  return (
    <div className="activity-window">
      <ActivityLog notify={setToast} />
      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  )
}
