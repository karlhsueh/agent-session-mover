import type { SessionKey } from '../../../shared/sessions'
import { rowSessions, type DisplayRow, type RowKey } from './rows'

export interface Selection {
  keys: ReadonlySet<SessionKey>
  /** Where a shift-click or shift-arrow range starts. */
  anchor: RowKey | null
  /** The row the keyboard is on. The detail panel shows it, or the parent of a subagent row. */
  focus: RowKey | null
}

/** `rows` is the visible rows, top to bottom. Moves and ranges only cover visible rows. */
export type SelectionAction =
  | { type: 'click'; key: SessionKey; mode: 'only' | 'toggle' | 'range'; rows: readonly DisplayRow[] }
  | { type: 'focus'; key: RowKey }
  | { type: 'move'; to: 'next' | 'previous' | 'first' | 'last'; extend: boolean; rows: readonly DisplayRow[] }
  | { type: 'toggle-focus'; rows: readonly DisplayRow[] }
  | { type: 'toggle-group'; key: RowKey; sessions: readonly SessionKey[] }
  | { type: 'all'; keys: readonly SessionKey[] }
  | { type: 'clear' }
  | { type: 'retain'; existing: ReadonlySet<SessionKey> }

export const NO_SELECTION: Selection = { keys: new Set(), anchor: null, focus: null }

/** The focus stays on the stored row while it is visible, and falls back to the top session otherwise. */
export function focusedKey(selection: Selection, rows: readonly DisplayRow[]): RowKey | null {
  if (selection.focus !== null && rows.some((row) => row.key === selection.focus)) return selection.focus
  return (rows.find((row) => row.kind === 'session') ?? rows[0])?.key ?? null
}

function range(rows: readonly DisplayRow[], from: RowKey | null, to: RowKey): SessionKey[] {
  const end = rows.findIndex((row) => row.key === to)
  const start = from === null ? -1 : rows.findIndex((row) => row.key === from)
  if (end < 0) return []
  if (start < 0) return rows[end]!.kind === 'session' ? [rows[end]!.key as SessionKey] : []
  return rows
    .slice(Math.min(start, end), Math.max(start, end) + 1)
    .flatMap((row) => (row.kind === 'session' ? [row.key] : []))
}

/** Adds every key, unless all of them are selected already, in which case it removes them. */
function toggledAll(keys: ReadonlySet<SessionKey>, toggle: readonly SessionKey[]): Set<SessionKey> {
  const next = new Set(keys)
  const allIn = toggle.every((key) => next.has(key))
  for (const key of toggle) {
    if (allIn) next.delete(key)
    else next.add(key)
  }
  return next
}

export function selectionReducer(state: Selection, action: SelectionAction): Selection {
  switch (action.type) {
    case 'click':
      if (action.mode === 'only') return { keys: new Set([action.key]), anchor: action.key, focus: action.key }
      if (action.mode === 'toggle') return { keys: toggledAll(state.keys, [action.key]), anchor: action.key, focus: action.key }
      return { keys: new Set(range(action.rows, state.anchor, action.key)), anchor: state.anchor ?? action.key, focus: action.key }
    case 'focus':
      return { ...state, focus: action.key }
    case 'move': {
      if (action.rows.length === 0) return state
      const current = focusedKey(state, action.rows)
      const index = Math.max(0, action.rows.findIndex((row) => row.key === current))
      const last = action.rows.length - 1
      const next = { first: 0, last, next: Math.min(index + 1, last), previous: Math.max(index - 1, 0) }[action.to]
      const focus = action.rows[next]!.key
      if (!action.extend) return { ...state, focus }
      const anchor = state.anchor ?? current ?? focus
      return { keys: new Set(range(action.rows, anchor, focus)), anchor, focus }
    }
    case 'toggle-focus': {
      const focus = focusedKey(state, action.rows)
      const row = action.rows.find((candidate) => candidate.key === focus)
      if (!row || rowSessions(row).length === 0) return state
      return { keys: toggledAll(state.keys, rowSessions(row)), anchor: row.key, focus: row.key }
    }
    case 'toggle-group':
      return { keys: toggledAll(state.keys, action.sessions), anchor: action.key, focus: action.key }
    case 'all':
      return { ...state, keys: new Set(action.keys) }
    case 'clear':
      return { ...state, keys: new Set(), anchor: null }
    case 'retain':
      return { ...state, keys: new Set([...state.keys].filter((key) => action.existing.has(key))) }
  }
}
