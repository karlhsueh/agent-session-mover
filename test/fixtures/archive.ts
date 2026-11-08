import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'

export interface RawEntry {
  name: string
  body: Buffer | string
  /** Tar typeflag: '0' regular, '2' symlink, '5' directory, 'x' pax header. */
  type?: string
  linkname?: string
  /** Size to write in the header when it should disagree with the body. */
  declaredSize?: number
}

/** Writes a tar independently of the app's writer so tests can build shapes the app never would. */
export function rawTar(entries: RawEntry[], { endMarker = true }: { endMarker?: boolean } = {}): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body)
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 'ascii')
    header.write('0000000\0', 108, 'ascii')
    header.write('0000000\0', 116, 'ascii')
    header.write((entry.declaredSize ?? body.length).toString(8).padStart(11, '0') + '\0', 124, 'ascii')
    header.write('00000000000\0', 136, 'ascii')
    header.fill(0x20, 148, 156)
    header.write(entry.type ?? '0', 156, 'ascii')
    if (entry.linkname) header.write(entry.linkname, 157, 100, 'utf8')
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  if (endMarker) blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

export async function writeRawArchive(file: string, entries: RawEntry[], options?: { endMarker?: boolean }): Promise<void> {
  await writeFile(file, gzipSync(rawTar(entries, options)))
}

/** Reads an archive the app wrote back into its entries, with a hand-rolled tar parser. */
export async function readArchiveEntries(file: string): Promise<Map<string, Buffer>> {
  const tar = gunzipSync(await readFile(file))
  const entries = new Map<string, Buffer>()
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '')
    const size = parseInt(header.toString('ascii', 124, 135), 8)
    entries.set(name, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}
