import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type Rgba = [number, number, number, number]

const css = readFileSync(new URL('../src/renderer/src/styles/base.css', import.meta.url), 'utf8')

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  const block = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]))
}

const THEMES = { dark: tokens(':root'), light: { ...tokens(':root'), ...tokens(":root[data-theme='light']") } }

function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) return [0, 2, 4].map((at) => parseInt(hex[1]!.slice(at, at + 2), 16)).concat(1) as Rgba
  const rgb = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(value)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4])]
  throw new Error(`Cannot read color ${value}`)
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3]
  return [0, 1, 2].map((i) => top[i]! * a + bottom[i]! * (1 - a)).concat(1) as Rgba
}

function luminance([r, g, b]: Rgba): number {
  const linear = (channel: number) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

export function ratio(fg: Rgba, bg: Rgba): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** Every surface text sits on, the selected-row tint included. */
function surfaces(theme: Record<string, string>): Record<string, Rgba> {
  const base = Object.fromEntries(['bg', 'surface', 'raised', 'hover'].map((name) => [name, parse(theme[name]!)]))
  return { ...base, selected: over(parse(theme.selected!), base.bg!) }
}

describe.each(Object.entries(THEMES))('%s theme contrast', (_name, theme) => {
  it.each(['text', 'muted', 'faint'])('--%s text reaches 4.5:1 on every surface', (token) => {
    for (const [surface, color] of Object.entries(surfaces(theme))) {
      expect(ratio(parse(theme[token]!), color), `--${token} on --${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('primary button text reaches 4.5:1 on the accent', () => {
    expect(ratio(parse(theme['accent-text']!), parse(theme.accent!))).toBeGreaterThanOrEqual(4.5)
  })
})
