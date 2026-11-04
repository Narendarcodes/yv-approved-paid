/**
 * Avatar initials from a display name: the first letter of the first two words,
 * ignoring anything in brackets and any word that does not start with a letter
 * or digit. "Ravi (demo editor)" -> "R", "Demo Judge" -> "DJ", "" -> "?".
 */
export function initialsOf(name?: string | null): string {
  const words = String(name ?? '')
    .replace(/[([{][^)\]}]*[)\]}]?/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean)
  return (
    words
      .slice(0, 2)
      .map((w) => Array.from(w)[0])
      .join('')
      .toUpperCase() || '?'
  )
}
