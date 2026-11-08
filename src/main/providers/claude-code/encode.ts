const MAX_ENCODED = 200

/** Claude Code's project folder name for a working directory. See docs/session-storage.md, "Project folder name". */
export function encodeProjectDir(cwd: string): string {
  // No `u` flag: Claude Code replaces each UTF-16 code unit, so one astral character becomes two dashes.
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (encoded.length <= MAX_ENCODED) return encoded
  return `${encoded.slice(0, MAX_ENCODED)}-${Math.abs(javaStringHash(cwd)).toString(36)}`
}

function javaStringHash(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  return hash
}
