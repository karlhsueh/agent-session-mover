import { describe, expect, it } from 'vitest'
import { mapPath } from '../src/main/core/paths'
import { rewriteTranscript } from '../src/main/providers/claude-code/transcript'

const rules = {
  mapCwd: (value: string) => mapPath(value, [{ source: '/Users/a/proj', target: '/home/b/work' }], '/', '/'),
  storeFiles: new Map([['/Users/a/.claude/projects/-Users-a-proj/s/tool-results/t.txt', '/home/b/.claude/projects/-home-b-work/s/tool-results/t.txt']]),
}

async function run(input: string | Buffer, chunkSize = 7): Promise<Buffer> {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
  async function* chunks() {
    for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize)
  }
  const out: Buffer[] = []
  for await (const chunk of rewriteTranscript(rules)(chunks())) out.push(chunk)
  return Buffer.concat(out)
}

const line = (value: unknown) => JSON.stringify(value)

describe('rewriteTranscript', () => {
  it('rewrites the three structured fields, including paths under a mapped folder', async () => {
    const input = [
      line({ type: 'user', cwd: '/Users/a/proj/sub', message: { content: 'cd /Users/a/proj' } }),
      line({ type: 'attachment', attachment: { snapshot: { workingDirectory: '/Users/a/proj' } } }),
      line({ type: 'user', toolUseResult: { persistedOutputPath: '/Users/a/.claude/projects/-Users-a-proj/s/tool-results/t.txt', filePath: '/Users/a/proj/x' } }),
    ].join('\n') + '\n'
    const out = (await run(input)).toString().trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(out[0]).toEqual({ type: 'user', cwd: '/home/b/work/sub', message: { content: 'cd /Users/a/proj' } })
    expect(out[1].attachment.snapshot.workingDirectory).toBe('/home/b/work')
    expect(out[2].toolUseResult).toEqual({ persistedOutputPath: '/home/b/.claude/projects/-home-b-work/s/tool-results/t.txt', filePath: '/Users/a/proj/x' })
  })

  it('leaves a path that only shares a prefix with a mapped folder alone', async () => {
    const input = line({ cwd: '/Users/a/project-two' }) + '\n'
    expect((await run(input)).toString()).toBe(input)
  })

  it('drops an unparsable final line', async () => {
    const good = line({ cwd: '/elsewhere' }) + '\n'
    expect((await run(good + '{"type":"assist')).toString()).toBe(good)
  })

  it('adds the missing newline to a complete final line', async () => {
    expect((await run(line({ cwd: '/elsewhere' }))).toString()).toBe(line({ cwd: '/elsewhere' }) + '\n')
  })

  it('keeps an unparsable middle line byte for byte', async () => {
    const input = 'not json\n' + line({ cwd: '/elsewhere' }) + '\n'
    expect((await run(input)).toString()).toBe(input)
  })

  it('leaves a line alone when re-serializing it would change other bytes', async () => {
    const spaced = '{"cwd": "/Users/a/proj", "n": 1.0}\n'
    const escaped = '{"cwd":"/Users/a/proj","t":"caf\\u00e9"}\n'
    expect((await run(spaced)).toString()).toBe(spaced)
    expect((await run(escaped)).toString()).toBe(escaped)
  })

  it('keeps invalid UTF-8 bytes intact', async () => {
    const input = Buffer.concat([Buffer.from('{"cwd":"/Users/a/proj","t":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')])
    expect(await run(input)).toEqual(input)
  })

  it('gives the same bytes whatever the chunk boundaries', async () => {
    const input = [line({ cwd: '/Users/a/proj', t: 'é ✓ 🚀' }), line({ x: 1 })].join('\n') + '\n'
    expect(await run(input, 1)).toEqual(await run(input, 4096))
  })
})
