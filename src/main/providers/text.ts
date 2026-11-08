const TITLE_LIMIT = 200

/** Collapses whitespace and caps the length, so a title fits one list row. */
export function cleanTitle(value: string): string | null {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return null
  return collapsed.length > TITLE_LIMIT ? `${collapsed.slice(0, TITLE_LIMIT - 1)}…` : collapsed
}

/** A shell line that resumes a session, with a `cd` into its folder when the folder is known. */
export function resumeLine(command: string, cwd: string | null): string {
  if (!cwd) return command
  const quoted = process.platform === 'win32' ? `"${cwd.replace(/"/g, '""')}"` : `'${cwd.replace(/'/g, `'\\''`)}'`
  return `cd ${quoted} && ${command}`
}
