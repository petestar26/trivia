export function NumberBall({ target }: { target: number | null }) {
  return (
    <div className="number-ball" aria-hidden="true">
      <div className="number-orbit" aria-hidden="true" />
      <span>{target != null ? String(target).padStart(2, '0') : '?'}</span>
    </div>
  );
}
