import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ProgressEvent } from '../../shared/sessions'

/** Archive open reports once per chunk read, so events are folded into one render per frame. */
export function useProgress(): [ProgressEvent | null, () => void] {
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const latest = useRef<ProgressEvent | null>(null)
  const frame = useRef<number | null>(null)

  useEffect(() => {
    const unsubscribe = window.api.onProgress((event) => {
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
