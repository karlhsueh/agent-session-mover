import { IS_MAC, MOD } from '../model/format'
import { Kbd, Sheet } from './common'

type Shortcut = [keys: string[], what: string]

const CLICK_MOD = IS_MAC ? '⌘' : 'Ctrl'

type Group = [title: string, shortcuts: Shortcut[]]

/** Two columns, so the sheet fits a short window without scrolling. */
const COLUMNS: Group[][] = [
  [
    [
      'Sessions',
      [
        [['↑', '↓'], 'Move through projects or sessions'],
        [['←', '→'], 'Go to the projects or the sessions'],
        [['Space'], 'Select or unselect the focused session'],
        [['Shift', '↑↓'], 'Extend the selection'],
        [[`${MOD}A`], 'Select every session in the list'],
        [['Esc'], 'Clear the search, then the selection'],
      ],
    ],
    [
      'Mouse',
      [
        [['Click'], 'Preview a session'],
        [[CLICK_MOD, 'Click'], 'Select or unselect a session'],
        [['Shift', 'Click'], 'Select a range of sessions'],
      ],
    ],
  ],
  [
    [
      'App',
      [
        [[`${MOD}F`, '/'], 'Search'],
        [[`${MOD}\\`], 'Show or hide the projects'],
        [[`${MOD}E`], 'Export the selection'],
        [[`${MOD}O`], 'Import an archive'],
        [[`${MOD}R`], 'Look for new and changed sessions'],
        [['?'], 'Show these shortcuts'],
      ],
    ],
    [
      'Import',
      [
        [[`${MOD}${IS_MAC ? '↩' : 'Enter'}`], 'Start the import'],
        [['Esc'], 'Leave the import'],
      ],
    ],
  ],
]

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <Sheet label="Keyboard shortcuts" onClose={onClose}>
      <h2>Keyboard shortcuts</h2>
      <div className="shortcut-columns">
        {COLUMNS.map((groups) => (
          <div key={groups[0]![0]}>
            {groups.map(([title, shortcuts]) => (
              <section key={title} className="shortcut-group" aria-label={title}>
                <h3>{title}</h3>
                <dl className="shortcuts">
                  {shortcuts.map(([keys, what]) => (
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
              </section>
            ))}
          </div>
        ))}
      </div>
      <div className="sheet-actions">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Sheet>
  )
}
