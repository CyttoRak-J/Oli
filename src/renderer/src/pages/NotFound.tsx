import { useNavigate } from 'react-router-dom'
import { Compass, ArrowLeft } from 'lucide-react'
import { EmptyState } from '../components/EmptyState'

export function NotFound(): React.JSX.Element {
  const navigate = useNavigate()
  return (
    <div className="p-6">
      <EmptyState
        icon={<Compass size={40} className="mx-auto" />}
        title="Page not found"
        description="This page doesn't exist or has moved."
        action={
          <div className="mt-2 flex items-center justify-center gap-2">
            <button
              className="flex items-center gap-1.5 rounded-lg border border-surface-4 bg-surface-2 px-4 py-2 text-[13px] font-semibold text-ink-1 transition-colors hover:border-accent"
              onClick={() => navigate(-1)}
            >
              <ArrowLeft size={14} /> Go back
            </button>
            <button
              className="rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
              onClick={() => navigate('/')}
            >
              Back to Home
            </button>
          </div>
        }
      />
    </div>
  )
}