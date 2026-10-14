/** Preserve a readable horizontal broadcast angle when the arena becomes portrait. */
export function broadcastFov(verticalDegrees: number, aspect: number) {
  const scale = Math.max(1, Math.min(1.8, 16 / 9 / Math.max(0.4, aspect)));
  return Math.min(
    70,
    (Math.atan(Math.tan((verticalDegrees * Math.PI) / 360) * scale) * 360) / Math.PI
  );
}
