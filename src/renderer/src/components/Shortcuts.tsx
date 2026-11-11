import { MOD } from '../model/format'
import { Kbd, Sheet } from './common'

const SHORTCUTS: [keys: string[], what: string][] = [
  [['↑', '↓'], 'Move through projects or sessions'],
  [['←', '→'], 'Go to the projects or the sessions'],
  [['Space'], 'Select or unselect the focused session'],
  [['Shift', '↑↓'], 'Extend the selection'],
  [[`${MOD}A`], 'Select every session in the list'],
  [[`${MOD}\\`], 'Show or hide the projects'],
  [['Esc'], 'Clear the search, then the selection'],
  [[`${MOD}F`], 'Search'],
  [[`${MOD}E`], 'Export the selection'],
  [[`${MOD}O`], 'Import an archive'],
  [[`${MOD}R`], 'Look for new and changed sessions'],
  [['?'], 'Show these shortcuts'],
]

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <Sheet label="Keyboard shortcuts" onClose={onClose}>
      <h2>Keyboard shortcuts</h2>
      <dl className="shortcuts">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={what}>
            <dt>
              {keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <div className="sheet-actions">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Sheet>
  )
}
