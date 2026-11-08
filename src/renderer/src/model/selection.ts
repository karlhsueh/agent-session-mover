import type { SessionKey } from '../../../shared/sessions'

export interface Selection {
  keys: ReadonlySet<SessionKey>
  /** Where a shift-click or shift-arrow range starts. */
  anchor: SessionKey | null
  /** The row the keyboard is on. The detail panel shows it. */
  focus: SessionKey | null
}

/** `rows` is the visible list, top to bottom. Moves and ranges only cover visible rows. */
export type SelectionAction =
  | { type: 'click'; key: SessionKey; mode: 'only' | 'toggle' | 'range'; rows: readonly SessionKey[] }
  | { type: 'move'; to: 'next' | 'previous' | 'first' | 'last'; extend: boolean; rows: readonly SessionKey[] }
  | { type: 'toggle-focus'; rows: readonly SessionKey[] }
  | { type: 'all'; keys: readonly SessionKey[] }
  | { type: 'clear' }
  | { type: 'retain'; existing: ReadonlySet<SessionKey> }

export const NO_SELECTION: Selection = { keys: new Set(), anchor: null, focus: null }

/** The focus stays on the stored row while it is visible, and falls back to the top row otherwise. */
export function focusedKey(selection: Selection, rows: readonly SessionKey[]): SessionKey | null {
  if (selection.focus !== null && rows.includes(selection.focus)) return selection.focus
  return rows[0] ?? null
}

function range(rows: readonly SessionKey[], from: SessionKey | null, to: SessionKey): SessionKey[] {
  const end = rows.indexOf(to)
  const start = from === null ? -1 : rows.indexOf(from)
  if (end < 0) return []
  if (start < 0) return [to]
  return rows.slice(Math.min(start, end), Math.max(start, end) + 1)
}

function toggled(keys: ReadonlySet<SessionKey>, key: SessionKey): Set<SessionKey> {
  const next = new Set(keys)
  if (!next.delete(key)) next.add(key)
  return next
}

export function selectionReducer(state: Selection, action: SelectionAction): Selection {
  switch (action.type) {
    case 'click':
      if (action.mode === 'only') return { keys: new Set([action.key]), anchor: action.key, focus: action.key }
      if (action.mode === 'toggle') return { keys: toggled(state.keys, action.key), anchor: action.key, focus: action.key }
      return { keys: new Set(range(action.rows, state.anchor, action.key)), anchor: state.anchor ?? action.key, focus: action.key }
    case 'move': {
      if (action.rows.length === 0) return state
      const current = focusedKey(state, action.rows)
      const index = Math.max(0, current === null ? 0 : action.rows.indexOf(current))
      const last = action.rows.length - 1
      const next = { first: 0, last, next: Math.min(index + 1, last), previous: Math.max(index - 1, 0) }[action.to]
      const focus = action.rows[next]!
      if (!action.extend) return { ...state, focus }
      const anchor = state.anchor ?? current ?? focus
      return { keys: new Set(range(action.rows, anchor, focus)), anchor, focus }
    }
    case 'toggle-focus': {
      const focus = focusedKey(state, action.rows)
      return focus === null ? state : { keys: toggled(state.keys, focus), anchor: focus, focus }
    }
    case 'all':
      return { ...state, keys: new Set([...state.keys, ...action.keys]) }
    case 'clear':
      return { ...state, keys: new Set(), anchor: null }
    case 'retain':
      return { ...state, keys: new Set([...state.keys].filter((key) => action.existing.has(key))) }
  }
}
