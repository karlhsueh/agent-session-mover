// Minimal ustar: regular files with short names only. Anything else is an error on read.

const BLOCK = 512
// 11 octal digits is the ustar size field limit.
export const MAX_TAR_ENTRY = 0o77777777777

export class TarError extends Error {}

export interface TarEntryInput {
  name: string
  size: number
  mtimeMs: number
  body: () => AsyncIterable<Buffer>
}

export async function* writeTar(entries: AsyncIterable<TarEntryInput> | Iterable<TarEntryInput>): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    yield encodeHeader(entry.name, entry.size, entry.mtimeMs)
    let written = 0
    for await (const chunk of entry.body()) {
      written += chunk.length
      if (written > entry.size) throw new TarError(`${entry.name} is longer than ${entry.size} bytes`)
      yield chunk
    }
    if (written !== entry.size) throw new TarError(`${entry.name} is ${written} bytes, expected ${entry.size}`)
    const padding = paddingFor(entry.size)
    if (padding > 0) yield Buffer.alloc(padding)
  }
  yield Buffer.alloc(BLOCK * 2)
}

function encodeHeader(name: string, size: number, mtimeMs: number): Buffer {
  const nameBytes = Buffer.from(name, 'utf8')
  if (nameBytes.length === 0 || nameBytes.length > 100) throw new TarError(`Tar name ${name} is too long`)
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TAR_ENTRY) throw new TarError(`Tar entry ${name} is too large`)
  const header = Buffer.alloc(BLOCK)
  nameBytes.copy(header, 0)
  writeOctal(header, 100, 8, 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, Math.max(0, Math.floor(mtimeMs / 1000)))
  header.fill(0x20, 148, 156)
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  writeOctal(header, 148, 7, checksum(header))
  header[155] = 0x20
  return header
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii')
}

function checksum(header: Buffer): number {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]
  return sum
}

function paddingFor(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK
}

export interface TarEntry {
  name: string
  size: number
  /** Must be consumed before asking for the next entry; any unread bytes are skipped. */
  body: AsyncIterable<Buffer>
}

export async function* readTar(source: AsyncIterable<Buffer>): AsyncGenerator<TarEntry> {
  const reader = new ByteReader(source[Symbol.asyncIterator]())
  for (;;) {
    const header = await reader.read(BLOCK)
    if (!header) throw new TarError('Archive ends without an end-of-archive marker')
    if (isZero(header)) {
      const second = await reader.read(BLOCK)
      if (!second || !isZero(second)) throw new TarError('Archive has a malformed end-of-archive marker')
      for await (const rest of reader.rest()) {
        if (!isZero(rest)) throw new TarError('Archive has data after the end-of-archive marker')
      }
      return
    }
    const { name, size } = decodeHeader(header)
    let remaining = size
    const body = (async function* () {
      while (remaining > 0) {
        const chunk = await reader.readSome(remaining)
        if (!chunk) throw new TarError(`${name} is truncated`)
        remaining -= chunk.length
        yield chunk
      }
    })()
    yield { name, size, body }
    while (remaining > 0) {
      const chunk = await reader.readSome(remaining)
      if (!chunk) throw new TarError(`${name} is truncated`)
      remaining -= chunk.length
    }
    const padding = paddingFor(size)
    if (padding > 0 && !(await reader.read(padding))) throw new TarError(`${name} is truncated`)
  }
}

function decodeHeader(header: Buffer): { name: string; size: number } {
  const stored = parseOctal(header, 148, 8)
  if (stored !== checksum(header)) throw new TarError('Tar header has the wrong checksum')
  if (header.toString('ascii', 257, 263) !== 'ustar\0' || header.toString('ascii', 263, 265) !== '00') {
    throw new TarError('Tar entry is not ustar')
  }
  const type = header[156]
  if (type !== 0x30 && type !== 0) throw new TarError(`Tar entry type ${JSON.stringify(String.fromCharCode(type))} is not a regular file`)
  if (header[345] !== 0) throw new TarError('Tar entry uses a name prefix')
  const nameEnd = header.indexOf(0, 0)
  const name = header.toString('utf8', 0, nameEnd === -1 || nameEnd > 100 ? 100 : nameEnd)
  const size = parseOctal(header, 124, 12)
  return { name, size }
}

function parseOctal(header: Buffer, offset: number, length: number): number {
  const raw = header.toString('ascii', offset, offset + length).replace(/[\0 ]+$/, '').replace(/^ +/, '')
  if (!/^[0-7]{1,11}$/.test(raw)) throw new TarError('Tar header has a malformed number')
  return parseInt(raw, 8)
}

function isZero(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false
  return true
}

class ByteReader {
  private chunks: Buffer[] = []
  private buffered = 0
  private done = false

  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async pull(): Promise<boolean> {
    if (this.done) return false
    const next = await this.source.next()
    if (next.done) {
      this.done = true
      return false
    }
    if (next.value.length > 0) {
      this.chunks.push(next.value)
      this.buffered += next.value.length
    }
    return true
  }

  /** Exactly `n` bytes, or null at end of input. A partial read is an error. */
  async read(n: number): Promise<Buffer | null> {
    while (this.buffered < n) {
      if (!(await this.pull())) {
        if (this.buffered === 0) return null
        throw new TarError('Archive is truncated')
      }
    }
    return this.take(n)
  }

  /** Between 1 and `max` bytes, or null at end of input. */
  async readSome(max: number): Promise<Buffer | null> {
    while (this.buffered === 0) if (!(await this.pull())) return null
    return this.take(Math.min(max, this.chunks[0].length))
  }

  async *rest(): AsyncGenerator<Buffer> {
    for (;;) {
      const chunk = await this.readSome(Number.MAX_SAFE_INTEGER)
      if (!chunk) return
      yield chunk
    }
  }

  private take(n: number): Buffer {
    const out: Buffer[] = []
    let needed = n
    while (needed > 0) {
      const head = this.chunks[0]
      if (head.length <= needed) {
        out.push(head)
        this.chunks.shift()
        needed -= head.length
      } else {
        out.push(head.subarray(0, needed))
        this.chunks[0] = head.subarray(needed)
        needed = 0
      }
    }
    this.buffered -= n
    return out.length === 1 ? out[0] : Buffer.concat(out)
  }
}
