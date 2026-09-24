export function formatWhen(ts: number): string {
  const diff = Date.now() - ts
  const hourMs = 3_600_000
  const dayMs = 24 * hourMs
  if (diff < hourMs) return `${Math.max(1, Math.floor(diff / 60_000))}m`
  if (diff < dayMs) return `${Math.floor(diff / hourMs)}h`
  if (diff < 2 * dayMs) return 'Yesterday'
  if (diff < 7 * dayMs) return `${Math.floor(diff / dayMs)}d`
  return new Date(ts).toLocaleDateString()
}
