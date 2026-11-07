import { useState, type FormEvent } from 'react'
import { GREET_CHANNEL, type GreetResult, type RuntimeInfo } from '../../shared/ipc'

type GreetState =
  | { status: 'idle' }
  | { status: 'waiting' }
  | { status: 'done'; result: GreetResult }

const RUNTIME_FIELDS: (keyof RuntimeInfo)[] = ['pid', 'platform', 'electron', 'node', 'chrome']

function crossingText(state: GreetState): string {
  switch (state.status) {
    case 'idle':
      return 'Nothing sent yet'
    case 'waiting':
      return 'Crossing…'
    case 'done':
      return state.result.ok ? state.result.message : state.result.error
  }
}

export function App() {
  const [name, setName] = useState('')
  const [state, setState] = useState<GreetState>({ status: 'idle' })

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setState({ status: 'waiting' })
    setState({ status: 'done', result: await window.api.greet(name) })
  }

  // Read from globalThis because the bundler rewrites a bare `require` to its own
  // shim, and `typeof require` would then report "function" here.
  const typeofProcess = typeof globalThis.process
  const typeofRequire = typeof globalThis.require

  const result = state.status === 'done' ? state.result : null
  const runtime = result?.ok ? result.runtime : null

  return (
    <main className="boundary">
      <section className="side renderer">
        <header>
          <h2>Renderer</h2>
          <p>Chromium, sandboxed. No Node.</p>
        </header>

        <div className="body">
          <form onSubmit={handleSubmit}>
            <label htmlFor="name">Name</label>
            <input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              autoFocus
            />
            <button type="submit" disabled={state.status === 'waiting'}>
              Send to main
            </button>
          </form>

          <dl>
            <div>
              <dt>typeof process</dt>
              <dd>{typeofProcess}</dd>
            </div>
            <div>
              <dt>typeof require</dt>
              <dd>{typeofRequire}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="side main">
        <header>
          <h2>Main</h2>
          <p>Node.js, full access to the machine.</p>
        </header>

        <div className="body">
          <dl>
            {RUNTIME_FIELDS.map((field) => (
              <div key={field}>
                <dt>{field}</dt>
                <dd>{runtime?.[field] ?? '—'}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <div className={result?.ok === false ? 'crossing failed' : 'crossing'}>
        <small>ipc channel &ldquo;{GREET_CHANNEL}&rdquo;</small>
        <output>{crossingText(state)}</output>
      </div>
    </main>
  )
}
