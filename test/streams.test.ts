import { describe, expect, it } from 'vitest'
import { splitLines } from '../src/main/core/streams'

async function lines(chunks: string[], maxLine: number): Promise<string[]> {
  const out: string[] = []
  for await (const line of splitLines((async function* () { for (const chunk of chunks) yield Buffer.from(chunk) })(), maxLine)) out.push(line.bytes.toString())
  return out
}

describe('splitLines', () => {
  it('joins a line split across chunks', async () => {
    expect(await lines(['ab', 'c\nd', 'e\n'], 8)).toEqual(['abc', 'de'])
  })

  it('accepts a line exactly at the limit', async () => {
    expect(await lines(['abcd', 'efgh\n'], 8)).toEqual(['abcdefgh'])
  })

  it('throws on a line past the limit, whether or not a newline ends it', async () => {
    await expect(lines(['abcd', 'efghi\n'], 8)).rejects.toThrow('longer than 8 bytes')
    await expect(lines(['abcd', 'efgh', 'i'], 8)).rejects.toThrow('longer than 8 bytes')
  })
})
