import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { isSha256, type Manifest, parseManifest, type Sha256 } from '../core/manifest'
import { readRange } from '../core/streams'
import { MAX_TAR_ENTRY, readTar, type TarEntryInput, writeTar } from './tar'

export const ARCHIVE_EXTENSION = 'agentsessions'
const MANIFEST_ENTRY = 'manifest.json'
const BLOB_PREFIX = 'blobs/'

export class ArchiveError extends Error {}

export interface BlobSource {
  absPath: string
  start?: number
  size: number
  sha256: Sha256
  mtimeMs: number
}

/**
 * Writes `manifest.json` then one `blobs/<sha256>` entry per distinct blob. Each blob is re-read
 * and re-hashed while it streams, so a source file that changed after collection fails the export
 * instead of producing an archive whose manifest lies.
 */
export async function writeArchive(destPath: string, manifest: Manifest, blobs: ReadonlyMap<Sha256, BlobSource>): Promise<number> {
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
  const entries: TarEntryInput[] = [
    { name: MANIFEST_ENTRY, size: manifestBytes.length, mtimeMs: Date.parse(manifest.createdAt), body: () => once(manifestBytes) },
  ]
  for (const blob of blobs.values()) {
    entries.push({ name: BLOB_PREFIX + blob.sha256, size: blob.size, mtimeMs: blob.mtimeMs, body: () => verified(blob) })
  }

  const temp = path.join(path.dirname(destPath), `.${path.basename(destPath)}.${randomBytes(6).toString('hex')}.partial`)
  try {
    await pipeline(Readable.from(writeTar(entries)), createGzip(), createWriteStream(temp, { flags: 'wx' }))
    await fsyncPath(temp)
    await rename(temp, destPath)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  return (await stat(destPath)).size
}

async function* once(bytes: Buffer): AsyncGenerator<Buffer> {
  yield bytes
}

async function* verified(blob: BlobSource): AsyncGenerator<Buffer> {
  const hash = createHash('sha256')
  for await (const chunk of readRange(blob.absPath, blob.size, blob.start)) {
    hash.update(chunk)
    yield chunk
  }
  if (hash.digest('hex') !== blob.sha256) throw new ArchiveError(`${blob.absPath} changed while it was being exported`)
}

export async function fsyncPath(absPath: string): Promise<void> {
  const handle = await open(absPath, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export interface ArchiveLimits {
  manifestBytes: number
  entryBytes: number
  totalBytes: number
  entries: number
}

export const DEFAULT_LIMITS: ArchiveLimits = {
  manifestBytes: 64 * 1024 * 1024,
  entryBytes: MAX_TAR_ENTRY,
  totalBytes: 256 * 1024 ** 3,
  entries: 1_000_000,
}

export interface ExtractedArchive {
  manifest: Manifest
  /** Directory holding one verified file per blob, named by its hash. */
  blobDir: string
}

/**
 * Verifies the whole archive while copying its blobs into `stagingDir`. Returns only when every
 * blob the manifest names is present and matches its hash. On any error the staging dir is removed.
 */
export async function extractArchive(
  archivePath: string,
  stagingDir: string,
  limits: ArchiveLimits = DEFAULT_LIMITS,
  onProgress?: (bytesRead: number, bytesTotal: number) => void,
): Promise<ExtractedArchive> {
  const blobDir = path.join(stagingDir, 'blobs')
  await mkdir(blobDir, { recursive: true })
  try {
    const manifest = await extractInto(archivePath, blobDir, limits, onProgress)
    return { manifest, blobDir }
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true })
    throw error
  }
}

async function extractInto(
  archivePath: string,
  blobDir: string,
  limits: ArchiveLimits,
  onProgress?: (bytesRead: number, bytesTotal: number) => void,
): Promise<Manifest> {
  const bytesTotal = (await stat(archivePath)).size
  let bytesRead = 0
  const file = createReadStream(archivePath)
  file.on('data', (chunk) => {
    bytesRead += chunk.length
    onProgress?.(bytesRead, bytesTotal)
  })
  const gunzip = createGunzip()
  let unpacked = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      unpacked += chunk.length
      if (unpacked > limits.totalBytes + 1024 * 1024) callback(new ArchiveError('Archive is larger than the size limit'))
      else callback(null, chunk)
    },
  })
  const stream = file.pipe(gunzip).pipe(counter)
  const fail = (error: Error) => counter.destroy(error)
  file.on('error', fail)
  gunzip.on('error', (error) => fail(new ArchiveError(`This file is not a valid archive. The gzip reader reported "${error.message}".`)))

  let manifest: Manifest | null = null
  let expected = new Map<string, number>()
  const seen = new Set<string>()
  let entries = 0
  let total = 0
  try {
    for await (const entry of readTar(stream as AsyncIterable<Buffer>)) {
      entries += 1
      total += entry.size
      if (entries > limits.entries) throw new ArchiveError('Archive has too many entries')
      if (total > limits.totalBytes) throw new ArchiveError('Archive is larger than the size limit')

      if (!manifest) {
        if (entry.name !== MANIFEST_ENTRY) throw new ArchiveError('Archive does not start with manifest.json')
        if (entry.size > limits.manifestBytes) throw new ArchiveError('manifest.json is larger than the size limit')
        manifest = parseManifest(JSON.parse((await collect(entry.body)).toString('utf8')))
        expected = new Map(manifest.sessions.flatMap((session) => session.files.map((file) => [file.sha256, file.size])))
        let declared = 0
        for (const size of expected.values()) {
          if (size > limits.entryBytes) throw new ArchiveError('Archive has a file larger than the size limit')
          declared += size
        }
        if (declared > limits.totalBytes) throw new ArchiveError('Archive is larger than the size limit')
        if (expected.size + 1 > limits.entries) throw new ArchiveError('Archive has too many entries')
        continue
      }

      const sha = entry.name.startsWith(BLOB_PREFIX) ? entry.name.slice(BLOB_PREFIX.length) : ''
      if (!isSha256(sha) || !expected.has(sha)) throw new ArchiveError(`Archive has an unexpected entry ${JSON.stringify(entry.name)}`)
      if (seen.has(sha)) throw new ArchiveError(`Archive repeats blob ${sha}`)
      if (entry.size !== expected.get(sha)) throw new ArchiveError(`Blob ${sha} has the wrong size`)
      if (entry.size > limits.entryBytes) throw new ArchiveError(`Blob ${sha} is larger than the size limit`)
      seen.add(sha)
      await writeBlob(entry.body, path.join(blobDir, sha), sha)
    }
  } catch (error) {
    // `.pipe` does not pass a destroy upstream, so close every stage or the file stays open.
    for (const stage of [stream, gunzip, file]) stage.destroy()
    if (error instanceof SyntaxError) throw new ArchiveError('manifest.json is not valid JSON')
    throw error
  }
  if (!manifest) throw new ArchiveError('Archive is empty')
  for (const sha of expected.keys()) {
    if (!seen.has(sha)) throw new ArchiveError(`Archive is missing blob ${sha}`)
  }
  return manifest
}

async function collect(body: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function writeBlob(body: AsyncIterable<Buffer>, finalPath: string, sha: string): Promise<void> {
  const temp = `${finalPath}.partial`
  const hash = createHash('sha256')
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(Readable.from(body), hashing, createWriteStream(temp, { flags: 'wx' }))
  if (hash.digest('hex') !== sha) {
    await unlink(temp)
    throw new ArchiveError(`Blob ${sha} does not match its hash`)
  }
  await rename(temp, finalPath)
}
