export function localTimestamp(milliseconds = false, date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, milliseconds ? 23 : 19)
}

export function zonedTimestamp(date = new Date()): string {
  const offset = date.getTimezoneOffset()
  const absolute = Math.abs(offset)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const minutes = String(absolute % 60).padStart(2, '0')
  return `${localTimestamp(false, date)}${offset <= 0 ? '+' : '-'}${hours}:${minutes}`
}
