import type { RefObject } from 'react'
import type { SessionSummary } from '../../../shared/sessions'
import { agentOptions, clientOptions, SORTS, type BrowseQuery, type Grouping, type Option, type SortKey } from '../model/browse'
import { MOD } from '../model/format'
import { AgentMark } from './common'
import { SearchIcon } from './TitleBar'

interface Props {
  sessions: readonly SessionSummary[]
  query: BrowseQuery
  onChange: (query: BrowseQuery) => void
  grouping: Grouping
  onGrouping: (grouping: Grouping) => void
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
      <select aria-label={label} value={value ?? ''} onChange={(event) => onChange(event.target.value === '' ? null : (event.target.value as T))}>
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

const GROUPINGS: { value: Grouping; label: string; title: string }[] = [
  { value: 'project', label: 'Projects', title: 'Group by project' },
  { value: 'flat', label: 'Flat', title: 'Flat list' },
]

export function Toolbar({ sessions, query, onChange, grouping, onGrouping, searchRef }: Props) {
  const agents = agentOptions(sessions)
  const clients = clientOptions(sessions)
  return (
    <div className="filters">
      <label className="search">
        <SearchIcon />
        <span className="visually-hidden">Search sessions</span>
        <input
          ref={searchRef}
          type="search"
          placeholder="Search titles, folders, ids, subagents"
          value={query.text}
          onChange={(event) => onChange({ ...query, text: event.target.value })}
          spellCheck={false}
          autoComplete="off"
        />
        <kbd className="search-hint">{MOD}F</kbd>
      </label>
      {agents.length > 1 && (
        <span className="chips" role="group" aria-label="Agent">
          {agents.map((agent) => (
            <button
              key={agent.value}
              type="button"
              className="chip"
              aria-pressed={query.agent === agent.value}
              onClick={() => onChange({ ...query, agent: query.agent === agent.value ? null : agent.value })}
            >
              <AgentMark agent={agent.value} />
              {agent.label}
            </button>
          ))}
        </span>
      )}
      {clients.length > 1 && (
        <Picker label="Client" allLabel="All clients" value={query.client} options={clients} onChange={(client) => onChange({ ...query, client })} />
      )}
      <span className="segmented" role="group" aria-label="Grouping">
        {GROUPINGS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={grouping === option.value}
            aria-label={option.title}
            title={option.title}
            onClick={() => onGrouping(option.value)}
          >
            {option.label}
          </button>
        ))}
      </span>
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
