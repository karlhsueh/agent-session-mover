import { useCallback, useEffect, useRef, useState } from 'react'
import type { StoreRoot } from '../../shared/ipc'
import type { ExportResult, PathMapping, SessionKey } from '../../shared/sessions'
import { Browser } from './components/Browser'
import { ErrorBanner } from './components/common'
import { ExportSheet } from './components/ExportSheet'
import { ImportDone } from './components/ImportDone'
import { ImportingSheet, ImportPreview, OpeningSheet } from './components/ImportPreview'
import { ScanPanel } from './components/ScanStatus'
import { TitleBar } from './components/TitleBar'
import { useNow, useProgress, useTheme } from './hooks'
import { sessionTitle } from './model/format'
import { useListings } from './useListings'
import type { OpenedArchive, PreviewScreen, PreviewState, Screen } from './state'
import { shownPreview } from './state'

const BROWSE: Screen = { kind: 'browse', error: null }

export function App() {
  const [theme, toggleTheme] = useTheme()
  const [progress, resetProgress] = useProgress()
  const now = useNow()
  const { listings, list, settled, scans, refreshing, refresh } = useListings()
  const [storeRoots, setStoreRoots] = useState<StoreRoot[]>([])
  const [screen, setScreen] = useState<Screen>(BROWSE)
  const [lastExport, setLastExport] = useState<ExportResult | null>(null)

  useEffect(() => {
    void window.api.storeRoots().then(setStoreRoots)
  }, [])

  // previewImport refuses a second call while one runs, so mapping edits made meanwhile wait
  // for it and only the newest set is planned next.
  const wantedMappings = useRef<PathMapping[]>([])
  const previewRunning = useRef(false)
  const runPreview = useCallback(async (archive: OpenedArchive, mappings: PathMapping[]) => {
    wantedMappings.current = mappings
    if (previewRunning.current) return
    previewRunning.current = true
    try {
      for (;;) {
        const asked = wantedMappings.current
        const result = await window.api.previewImport(archive.token, asked)
        if (wantedMappings.current !== asked) continue
        const update = (state: PreviewState): PreviewState =>
          result.ok ? { status: 'ready', value: result.value } : { status: 'failed', error: result.error, last: shownPreview(state) }
        setScreen((current) =>
          current.kind === 'import-preview' && current.archive.token === archive.token ? { ...current, preview: update(current.preview) } : current,
        )
        return
      }
    } finally {
      previewRunning.current = false
    }
  }, [])

  const startImport = useCallback(async () => {
    resetProgress()
    setScreen({ kind: 'opening' })
    const result = await window.api.openArchive()
    if (!result.ok) return setScreen({ kind: 'browse', error: result.error })
    if (result.value.kind === 'cancelled') return setScreen(BROWSE)
    const archive: OpenedArchive = { token: result.value.token, summary: result.value.archive }
    const mappings = result.value.suggestedMappings
    setScreen({ kind: 'import-preview', archive, mappings, preview: { status: 'loading', last: null }, excluded: new Set(), error: null })
    void runPreview(archive, mappings)
  }, [resetProgress, runPreview])

  const startExport = useCallback((keys: SessionKey[]) => setScreen({ kind: 'export-confirm', keys, error: null }), [])

  async function confirmExport(keys: SessionKey[]) {
    resetProgress()
    setScreen({ kind: 'exporting', keys })
    const result = await window.api.exportSessions(keys)
    if (!result.ok) return setScreen({ kind: 'export-confirm', keys, error: result.error })
    if (result.value.kind === 'cancelled') return setScreen(BROWSE)
    setScreen({ kind: 'export-done', result: result.value })
    setLastExport(result.value)
  }

  function updatePreview(change: (current: PreviewScreen) => PreviewScreen) {
    setScreen((current) => (current.kind === 'import-preview' ? change(current) : current))
  }

  function changeMapping(from: PreviewScreen, source: string, target: string) {
    const mappings = from.mappings.map((mapping) => (mapping.source === source ? { source, target } : mapping))
    updatePreview((current) => ({ ...current, mappings, preview: { status: 'loading', last: shownPreview(current.preview) } }))
    void runPreview(from.archive, mappings)
  }

  async function runImport(from: PreviewScreen, keys: SessionKey[]) {
    resetProgress()
    setScreen({ kind: 'importing', from, keys })
    const result = await window.api.runImport(from.archive.token, from.mappings, keys)
    if (!result.ok) return setScreen({ ...from, error: result.error })
    setScreen({ kind: 'import-done', archive: from.archive, result: result.value })
    refresh('user')
  }

  function backToBrowse() {
    setScreen(BROWSE)
    refresh('user')
  }

  const inImport = screen.kind === 'import-preview' || screen.kind === 'importing' || screen.kind === 'import-done'
  // An empty answer from one agent is not an empty machine while another is still reading.
  const browsing = list !== null && (list.sessions.length > 0 || settled)

  return (
    <div className="app">
      {!(browsing && !inImport) && (
        <TitleBar theme={theme} onToggleTheme={toggleTheme}>
          <span className="app-name">Agent Sessions</span>
        </TitleBar>
      )}

      {screen.kind === 'import-preview' || screen.kind === 'importing' ? (
        <ImportPreview
          screen={screen.kind === 'importing' ? screen.from : screen}
          onMappingChange={(source, target) => screen.kind === 'import-preview' && changeMapping(screen, source, target)}
          onToggle={(key) =>
            updatePreview((current) => {
              const excluded = new Set(current.excluded)
              if (!excluded.delete(key)) excluded.add(key)
              return { ...current, excluded }
            })
          }
          onRun={(keys) => screen.kind === 'import-preview' && void runImport(screen, keys)}
          onBack={backToBrowse}
          onDismissError={() => updatePreview((current) => ({ ...current, error: null }))}
        />
      ) : screen.kind === 'import-done' ? (
        <ImportDone screen={screen} onDone={backToBrowse} />
      ) : !browsing ? (
        <ScanPanel listings={listings} scans={scans} />
      ) : (
        <Browser
          list={list}
          scans={scans}
          refreshing={refreshing}
          onRefresh={() => refresh('user')}
          storeRoots={storeRoots}
          now={now}
          active={screen.kind === 'browse'}
          onExport={startExport}
          lastExport={lastExport}
          onImport={() => void startImport()}
          theme={theme}
          onToggleTheme={toggleTheme}
          notice={screen.kind === 'browse' && screen.error && <ErrorBanner error={screen.error} onDismiss={() => setScreen(BROWSE)} />}
        />
      )}

      {(screen.kind === 'export-confirm' || screen.kind === 'exporting' || screen.kind === 'export-done') && (
        <ExportSheet
          screen={screen}
          sessions={list?.sessions ?? []}
          progress={progress}
          onConfirm={() => screen.kind === 'export-confirm' && void confirmExport(screen.keys)}
          onClose={() => setScreen(BROWSE)}
        />
      )}
      {screen.kind === 'opening' && <OpeningSheet progress={progress} />}
      {screen.kind === 'importing' && (
        <ImportingSheet
          keys={screen.keys}
          progress={progress}
          titles={new Map(screen.from.archive.summary.sessions.map((session) => [session.key, sessionTitle(session)]))}
        />
      )}
    </div>
  )
}
