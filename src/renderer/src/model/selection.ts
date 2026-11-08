import type { SessionKey } from '../../../shared/sessions'

export interface Selection {
  keys: ReadonlySet<SessionKey>
  /** Where a shift-click or shift-arrow range starts. */
  anchor: SessionKey | null
  /** The row the keyboard is on and the detail panel shows. */
  focus: SessionKey | null
}

/** `order` is the visible rows, top to bottom. Ranges and moves only cover visible rows. */
export type SelectionAction =
  | { type: 'click'; key: SessionKey; mode: 'only' | 'toggle' | 'range'; order: readonly SessionKey[] }
  | { type: 'move'; to: 'next' | 'previous' | 'first' | 'last'; extend: boolean; order: readonly SessionKey[] }
  | { type: 'toggle-focus'; order: readonly SessionKey[] }
  | { type: 'all'; order: readonly SessionKey[] }
  | { type: 'clear' }
  | { type: 'retain'; existing: ReadonlySet<SessionKey> }

export const NO_SELECTION: Selection = { keys: new Set(), anchor: null, focus: null }

/** The focus stays on the stored row while it is visible, and falls back to the top row otherwise. */
export function focusedKey(selection: Selection, order: readonly SessionKey[]): SessionKey | null {
  return selection.focus !== null && order.includes(selection.focus) ? selection.focus : (order[0] ?? null)
}

function range(order: readonly SessionKey[], from: SessionKey | null, to: SessionKey): SessionKey[] {
  const end = order.indexOf(to)
  const start = from === null ? -1 : order.indexOf(from)
  if (start < 0 || end < 0) return [to]
  return order.slice(Math.min(start, end), Math.max(start, end) + 1)
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
      return { keys: new Set(range(action.order, state.anchor, action.key)), anchor: state.anchor ?? action.key, focus: action.key }
    case 'move': {
      if (action.order.length === 0) return state
      const current = focusedKey(state, action.order)
      const index = current === null ? 0 : action.order.indexOf(current)
      const last = action.order.length - 1
      const next = { first: 0, last, next: Math.min(index + 1, last), previous: Math.max(index - 1, 0) }[action.to]
      const focus = action.order[next]!
      if (!action.extend) return { ...state, focus }
      const anchor = state.anchor ?? current ?? focus
      return { keys: new Set(range(action.order, anchor, focus)), anchor, focus }
    }
    case 'toggle-focus': {
      const focus = focusedKey(state, action.order)
      return focus === null ? state : { keys: toggled(state.keys, focus), anchor: focus, focus }
    }
    case 'all':
      return { ...state, keys: new Set(action.order) }
    case 'clear':
      return { ...state, keys: new Set(), anchor: null }
    case 'retain': {
      const keep = (key: SessionKey | null) => (key !== null && action.existing.has(key) ? key : null)
      return { keys: new Set([...state.keys].filter((key) => action.existing.has(key))), anchor: keep(state.anchor), focus: keep(state.focus) }
    }
  }
}
