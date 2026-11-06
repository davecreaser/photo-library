import type { ClockSuggestion } from '../../../shared/types.ts'
import { formatDate } from '../format.ts'

function prettyFolder(dir: string): string {
  return dir.split('/').at(-1) ?? dir
}

export function ClockBanner({ suggestion: s, onApply, onDismiss }: { suggestion: ClockSuggestion; onApply: () => void; onDismiss: () => void }) {
  const years = Math.abs(s.offsetYears)
  const direction = s.offsetYears > 0 ? 'behind' : 'ahead'
  return (
    <div className="banner">
      <div className="banner-text">
        <strong>
          Your {s.camera}’s clock looks {years} year{years === 1 ? '' : 's'} {direction}
          {s.appliesBefore ? ` until ${formatDate(s.appliesBefore)}` : ''}.
        </strong>{' '}
        Folders like {s.evidence.slice(0, 3).map(prettyFolder).join(', ')} disagree with the camera’s dates.
        Fixing this corrects {s.photoCount.toLocaleString()} photos in Photo Library only. Your files are not changed, and you can undo it any time.
      </div>
      <div className="banner-actions">
        <button className="primary-small" onClick={onApply}>Fix dates</button>
        <button onClick={onDismiss}>Ignore</button>
      </div>
    </div>
  )
}
