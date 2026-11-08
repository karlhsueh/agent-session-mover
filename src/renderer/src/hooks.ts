import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ApiResult } from '../../shared/ipc'
import type { ProgressEvent, SessionPreview } from '../../shared/sessions'
import type { Loadable } from './state'

/** Archive open reports once per chunk read, so events are folded into one render per frame. */
export function useProgress(): [ProgressEvent | null, () => void] {
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const latest = useRef<ProgressEvent | null>(null)
  const frame = useRef<number | null>(null)

  useEffect(() => {
    const unsubscribe = window.api.onProgress((event) => {
      // A listing pass reports beside an export or import. Its progress has its own line.
      if (event.operation === 'scan') return
      latest.current = event
      frame.current ??= requestAnimationFrame(() => {
        frame.current = null
        setProgress(latest.current)
      })
    })
    return () => {
      unsubscribe()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    }
  }, [])

  const reset = useCallback(() => {
    latest.current = null
    setProgress(null)
  }, [])
  return [progress, reset]
}

export type Theme = 'dark' | 'light'
const THEME_KEY = 'agent-sessions.theme'

function storedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(storedTheme)
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // Storage can be unavailable. The theme still applies for this window.
    }
  }, [theme])
  return [theme, () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))]
}

/** Relative times re-render once a minute. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * State remembered in this window's localStorage, for per-viewer conveniences only. Storage can be
 * unavailable or hold anything, so `parse` returns the fallback for a value it does not accept.
 */
export function useStored<T>(key: string, parse: (raw: string | null) => T, serialize: (value: T) => string): [T, (update: (current: T) => T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return parse(localStorage.getItem(key))
    } catch {
      return parse(null)
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, serialize(value))
    } catch {
      // The value still applies for this window.
    }
  }, [key, value, serialize])
  return [value, setValue]
}

export function useHomeDir(): string {
  const [home, setHome] = useState('')
  useEffect(() => {
    void window.api.homeDir().then(setHome)
  }, [])
  return home
}

/**
 * Conversation previews, loaded on first request and kept until `generation` changes, such as when
 * another archive opens. `version` names the state of one session's transcript, so a refresh that
 * changed one session reloads only that session's preview.
 */
export function usePreviews<K extends string>(
  load: (key: K) => Promise<ApiResult<SessionPreview>>,
  generation: unknown,
  version: (key: K) => string = () => '',
): [(key: K) => Loadable<SessionPreview> | null, (key: K) => void] {
  const [cache, setCache] = useState<{ generation: unknown; byKey: ReadonlyMap<string, Loadable<SessionPreview>> }>({ generation, byKey: new Map() })
  const byKey = cache.generation === generation ? cache.byKey : null
  const asked = useRef<{ generation: unknown; keys: Set<string> }>({ generation, keys: new Set() })
  const slot = (key: K) => `${key}\n${version(key)}`

  const request = useCallback(
    (key: K) => {
      if (asked.current.generation !== generation) asked.current = { generation, keys: new Set() }
      const at = `${key}\n${version(key)}`
      if (asked.current.keys.has(at)) return
      asked.current.keys.add(at)
      const store = (state: Loadable<SessionPreview>) =>
        setCache((current) => {
          const base = current.generation === generation ? current.byKey : new Map<string, Loadable<SessionPreview>>()
          return { generation, byKey: new Map(base).set(at, state) }
        })
      store({ status: 'loading' })
      void load(key).then((result) => {
        if (!result.ok) asked.current.keys.delete(at)
        store(result.ok ? { status: 'ready', value: result.value } : { status: 'failed', error: result.error })
      })
    },
    [load, generation, version],
  )
  return [(key) => byKey?.get(slot(key)) ?? null, request]
}
