import { mkdir } from 'node:fs/promises'

/** `mkdir -p`. A folder that already exists is left as it is. */
export async function createFolder(target: string): Promise<void> {
  try {
    await mkdir(target, { recursive: true })
  } catch (error) {
    throw new Error(folderMessage((error as NodeJS.ErrnoException).code))
  }
}

function folderMessage(code: string | undefined): string {
  switch (code) {
    case 'EEXIST':
    case 'ENOTDIR':
      return 'Part of this path is a file, not a folder.'
    case 'EACCES':
    case 'EPERM':
      return 'No permission to create a folder here.'
    case 'EROFS':
      return 'This disk is read-only.'
    default:
      return `Could not create this folder${code ? ` (${code})` : ''}.`
  }
}
