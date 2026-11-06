export function Welcome({ onChoose }: { onChoose: () => void }) {
  return (
    <div className="welcome">
      <div className="drag-region" />
      <h1>Photo Library</h1>
      <p>Choose the folder where your camera photos live. Photo Library indexes it so you can browse by date, search, and organise photos into albums.</p>
      <p className="hint">Your photos are only ever read. Nothing is moved, renamed or deleted. Albums and tags are stored separately by the app.</p>
      <button className="primary" onClick={onChoose}>Choose photo folder…</button>
    </div>
  )
}
