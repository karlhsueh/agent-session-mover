import { DAY, HOUR, type Fixture } from './claude-fixture.mts'

/**
 * Synthetic, but shaped like a real store: 52 sessions in 26 folders, one busy project, most
 * projects with a single session, two folder names that repeat, and one session with 19 subagents.
 */
const PROJECTS: [project: string, sessions: [title: string, ageMinutes: number, entrypoint?: string][]][] = [
  [
    'code/agent-sessions',
    [
      ['Try fixed panels for the session browser', 3, 'cli'],
      ['Group sessions by project and nest subagents', 2 * HOUR],
      ['Raise secondary text to 4.5:1 contrast', 5 * HOUR, 'claude-desktop'],
      ['Nest Codex subagents under their parent session', 9 * HOUR],
      ['Read the Codex state database without locking it', 20 * HOUR],
      ['Plan the import rollback journal', 1 * DAY + 4 * HOUR, 'claude-vscode'],
      ['Write the archive manifest parser', 1 * DAY + 9 * HOUR],
      ['Map source folders to this machine', 2 * DAY + 2 * HOUR],
      ['Snapshot a live session up to its last complete line', 2 * DAY + 7 * HOUR],
      ['Smoke test the export and import round trip', 3 * DAY, 'sdk-cli'],
      ['Harden the preload bridge', 3 * DAY + 6 * HOUR],
      ['Explain the IPC boundary in the docs', 4 * DAY, 'claude-desktop'],
      ['Find why tool-result paths break after import', 5 * DAY],
      ['Add the empty-store screen', 6 * DAY],
      ['Choose an archive format', 8 * DAY],
      ['Sketch the session browser', 10 * DAY, 'claude-desktop'],
      ['Scaffold the Electron app', 12 * DAY],
    ],
  ],
  [
    'code/api',
    [
      ['Fix flaky retry in the payment client', 40, 'claude-vscode'],
      ['Add cursor pagination to the orders endpoint', 6 * HOUR],
      ['Profile the slow invoice export', 2 * DAY],
      ['Rotate the webhook signing secret', 6 * DAY],
      ['Upgrade the ORM and fix the deprecations', 11 * DAY],
    ],
  ],
  [
    'code/web',
    [
      ['Migrate the settings page to the new form library', 3 * HOUR, 'claude-vscode'],
      ['Investigate the hydration warning on checkout', 3 * DAY],
      ['Make the pricing table responsive', 9 * DAY],
    ],
  ],
  ['code/tools', [['Nightly changelog summary', 7 * HOUR, 'sdk-cli']]],
  [
    'code/local-job-manager',
    [
      ['Plan the job queue rewrite', 1 * DAY + 2 * HOUR],
      ['Why is the localhost socket refusing connections', 4 * DAY],
    ],
  ],
  ['notes', [['Draft the onboarding doc', 1 * DAY + 6 * HOUR, 'claude-desktop']]],
  [
    'dotfiles',
    [
      ['Tidy the zsh prompt', 1 * DAY + 11 * HOUR],
      ['Move the git aliases into a separate file', 7 * DAY],
    ],
  ],
  [
    'work/api',
    [
      ['Trace the 502s behind the load balancer', 2 * DAY + 5 * HOUR],
      ['Write the rate limiter design doc', 8 * DAY, 'claude-desktop'],
    ],
  ],
  ['code/blog', [['Write up the session transfer post', 2 * DAY + 9 * HOUR, 'claude-desktop']]],
  [
    'infra',
    [
      ['Review the terraform plan for the staging VPC', 3 * DAY + 3 * HOUR],
      ['Cut the NAT gateway bill', 13 * DAY],
    ],
  ],
  ['code/ios-app', [['Fix the widget timeline refresh', 3 * DAY + 8 * HOUR, 'claude-vscode']]],
  ['code/cli-kit', [['Add shell completions', 4 * DAY + 2 * HOUR]]],
  ['experiments/llm-evals', [['Score the summarizer against the gold set', 4 * DAY + 7 * HOUR, 'sdk-cli']]],
  ['code/design-system', [['Audit the button focus rings', 5 * DAY + 1 * HOUR]]],
  ['code/scraper', [['Respect robots.txt and back off on 429', 5 * DAY + 6 * HOUR]]],
  ['work/billing', [['Reconcile the Stripe payouts', 6 * DAY + 2 * HOUR, 'claude-desktop']]],
  ['work/web', [['Fix the login redirect loop', 6 * DAY + 8 * HOUR]]],
  ['code/raytracer', [['Add bounding volume hierarchy', 7 * DAY + 3 * HOUR]]],
  ['code/advent', [['Day 12 solution is too slow', 8 * DAY + 4 * HOUR]]],
  ['sandbox', [['Try the new structured output API', 9 * DAY + 1 * HOUR, 'sdk-cli']]],
  ['code/terraform-modules', [['Publish the VPC module', 10 * DAY + 2 * HOUR]]],
  ['code/homelab', [['Set up backups for the NAS', 11 * DAY + 5 * HOUR, 'claude-desktop']]],
  ['code/recipes', [['Parse ingredient quantities', 12 * DAY + 3 * HOUR]]],
  ['code/resume', [['Tighten the resume to one page', 14 * DAY, 'claude-desktop']]],
  ['Downloads', [['What is in this CSV export', 15 * DAY]]],
  ['code/swift-charts', [['Animate the bar chart transitions', 17 * DAY, 'claude-vscode']]],
]

const SUBAGENT_TASKS: [type: string, description: string][] = [
  ['Explore', 'Map the worker lifecycle'],
  ['Explore', 'Find every caller of enqueue'],
  ['general-purpose', 'Write the lease migration'],
  ['Plan', 'Sketch the retry backoff'],
  ['general-purpose', 'Port the scheduler tests'],
  ['Explore', 'Read the socket permission code'],
  ['general-purpose', 'Fix the flaky heartbeat test'],
  ['Plan', 'Review the queue schema'],
  ['Explore', 'List the cron jobs that enqueue work'],
  ['general-purpose', 'Add a dead-letter queue'],
  ['Explore', 'Find where jobs are deduplicated'],
  ['general-purpose', 'Write the visibility timeout tests'],
  ['Plan', 'Order the migration steps'],
  ['Explore', 'Check how the old queue reports metrics'],
  ['general-purpose', 'Port the priority lanes'],
  ['Explore', 'Read the graceful shutdown path'],
  ['general-purpose', 'Wire the new queue behind a flag'],
  ['Plan', 'Write the rollback plan'],
  ['general-purpose', 'Update the runbook'],
]

export const FANOUT_TITLE = 'Plan the job queue rewrite'
export const LIVE_TITLE = 'Try fixed panels for the session browser'
/** One selected session in each of three projects. */
export const SELECTED_TITLES = ['Group sessions by project and nest subagents', 'Add cursor pagination to the orders endpoint', FANOUT_TITLE]

export const SCREEN_FIXTURES: Fixture[] = PROJECTS.flatMap(([project, sessions], p) =>
  sessions.map(([title, ageMinutes, entrypoint], s): Fixture => ({
    id: `5c${String(p).padStart(6, '0')}-0000-4000-8000-${String(s).padStart(12, '0')}`,
    title,
    project,
    entrypoint: entrypoint ?? 'cli',
    ageMinutes,
    live: title === LIVE_TITLE,
    subagents: title === FANOUT_TITLE ? SUBAGENT_TASKS.map(([type, description]) => ({ type, description })) : undefined,
  })),
)
