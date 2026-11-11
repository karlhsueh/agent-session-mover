import type { SessionKey } from '../../../shared/sessions'

export interface Selection {
  keys: ReadonlySet<SessionKey>
  /** Where a shift-click or shift-arrow range starts. */
  anchor: SessionKey | null
  /** What was selected when the anchor was set. A range adds to it, so extending never drops earlier picks. */
  base: ReadonlySet<SessionKey>
  /** The row the keyboard is on. The detail panel shows it. */
  focus: SessionKey | null
}

/**
 * `rows` is the visible list, top to bottom. Moves and ranges only cover visible rows.
 * A `focus` click previews the row and leaves the selection alone. A `check` click toggles the row and leaves the preview alone.
 */
export type SelectionAction =
  | { type: 'click'; key: SessionKey; mode: 'focus' | 'toggle' | 'check' | 'range'; rows: readonly SessionKey[] }
  | { type: 'move'; to: 'next' | 'previous' | 'first' | 'last'; extend: boolean; rows: readonly SessionKey[] }
  | { type: 'toggle-focus'; rows: readonly SessionKey[] }
  | { type: 'all'; keys: readonly SessionKey[] }
  | { type: 'clear' }
  | { type: 'retain'; existing: ReadonlySet<SessionKey> }

export const NO_SELECTION: Selection = { keys: new Set(), anchor: null, base: new Set(), focus: null }

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

/** Selects `base` plus the rows from `anchor` to `focus`. */
function extended(state: Selection, rows: readonly SessionKey[], anchor: SessionKey, focus: SessionKey): Selection {
  return { keys: new Set([...state.base, ...range(rows, anchor, focus)]), anchor, base: state.base, focus }
}

function anchored(keys: ReadonlySet<SessionKey>, at: SessionKey): Selection {
  return { keys, anchor: at, base: keys, focus: at }
}

export function selectionReducer(state: Selection, action: SelectionAction): Selection {
  switch (action.type) {
    case 'click':
      if (action.mode === 'focus') return anchored(state.keys, action.key)
      if (action.mode === 'toggle') return anchored(toggled(state.keys, action.key), action.key)
      if (action.mode === 'check') return { ...anchored(toggled(state.keys, action.key), action.key), focus: state.focus }
      return extended(state, action.rows, state.anchor ?? action.key, action.key)
    case 'move': {
      if (action.rows.length === 0) return state
      const current = focusedKey(state, action.rows)
      const index = Math.max(0, current === null ? 0 : action.rows.indexOf(current))
      const last = action.rows.length - 1
      const next = { first: 0, last, next: Math.min(index + 1, last), previous: Math.max(index - 1, 0) }[action.to]
      const focus = action.rows[next]!
      if (!action.extend) return anchored(state.keys, focus)
      return extended(state, action.rows, state.anchor ?? current ?? focus, focus)
    }
    case 'toggle-focus': {
      const focus = focusedKey(state, action.rows)
      return focus === null ? state : anchored(toggled(state.keys, focus), focus)
    }
    case 'all': {
      const keys = new Set([...state.keys, ...action.keys])
      return { ...state, keys, base: keys }
    }
    case 'clear':
      return { ...state, keys: new Set(), base: new Set(), anchor: null }
    case 'retain': {
      const keep = (set: ReadonlySet<SessionKey>) => new Set([...set].filter((key) => action.existing.has(key)))
      return { ...state, keys: keep(state.keys), base: keep(state.base) }
    }
  }
}
