import type { ReactNode } from 'react'
import type { Theme } from '../hooks'
import { IS_MAC } from '../model/format'

/** The window's drag region. On macOS it sits beside the traffic lights. */
export function TitleBar({ children, theme, onToggleTheme }: { children: ReactNode; theme: Theme; onToggleTheme: () => void }) {
  return (
    <header className={IS_MAC ? 'titlebar mac' : 'titlebar'}>
      {children}
      <button
        type="button"
        className="button ghost icon"
        onClick={onToggleTheme}
        aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
        title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
    </header>
  )
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.2 10.3A5.6 5.6 0 0 1 5.7 2.8a5.6 5.6 0 1 0 7.5 7.5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

export function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.5 10.5 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function SidebarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 3v10" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}
