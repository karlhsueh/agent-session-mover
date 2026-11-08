import type { RefObject } from 'react'
import type { SessionSummary } from '../../../shared/sessions'
import { agentOptions, clientOptions, projectOptions, SORTS, type BrowseQuery, type Option, type SortKey } from '../model/browse'
import { MOD } from '../model/format'
import { SearchIcon } from './TitleBar'

interface Props {
  sessions: readonly SessionSummary[]
  query: BrowseQuery
  onChange: (query: BrowseQuery) => void
  searchRef: RefObject<HTMLInputElement | null>
}

function Picker<T extends string>({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string
  allLabel: string | null
  value: T | null
  options: Option<T>[]
  onChange: (value: T | null) => void
}) {
  return (
    <span className={value === null || allLabel === null ? 'picker' : 'picker active'}>
      <select
        aria-label={label}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : (event.target.value as T))}
      >
        {allLabel !== null && <option value="">{allLabel}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  )
}

export function Filters({ sessions, query, onChange, searchRef }: Props) {
  return (
    <div className="filters">
      <label className="search">
        <SearchIcon />
        <span className="visually-hidden">Search sessions</span>
        <input
          ref={searchRef}
          type="search"
          placeholder="Search title, folder, or id"
          value={query.text}
          onChange={(event) => onChange({ ...query, text: event.target.value })}
          spellCheck={false}
          autoComplete="off"
        />
        <kbd className="search-hint">{MOD}F</kbd>
      </label>
      <Picker label="Agent" allLabel="All agents" value={query.agent} options={agentOptions(sessions)} onChange={(agent) => onChange({ ...query, agent })} />
      <Picker label="Client" allLabel="All clients" value={query.client} options={clientOptions(sessions)} onChange={(client) => onChange({ ...query, client })} />
      <Picker
        label="Project"
        allLabel="All projects"
        value={query.project}
        options={projectOptions(sessions)}
        onChange={(project) => onChange({ ...query, project })}
      />
      <Picker<SortKey>
        label="Sort by"
        allLabel={null}
        value={query.sort}
        options={Object.entries(SORTS).map(([value, sort]) => ({ value: value as SortKey, label: `Sort: ${sort.label}` }))}
        onChange={(sort) => onChange({ ...query, sort: sort ?? 'activity' })}
      />
    </div>
  )
}
