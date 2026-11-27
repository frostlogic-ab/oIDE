import type { DatabaseSync } from 'node:sqlite';

/**
 * Numbered schema migrations. Append only: never edit a migration that has shipped; add a new one.
 * Each runs in its own transaction; a backup of the file is taken before any pending one runs.
 */
export interface Migration {
  version: number;
  name: string;
  up: string | ((db: DatabaseSync) => void);
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  trusted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL,
  branch TEXT,
  worktree_path TEXT,
  base_ref TEXT,
  session_id TEXT,
  attempt_group TEXT,
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX agents_project ON agents(project_id);
CREATE INDEX agents_attempt_group ON agents(attempt_group);

CREATE TABLE subagents (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  status TEXT NOT NULL,
  tier TEXT,
  model TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  data TEXT NOT NULL,
  PRIMARY KEY (agent_id, id)
);

CREATE TABLE events (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL,
  data TEXT NOT NULL,
  raw TEXT,
  PRIMARY KEY (agent_id, seq)
);
CREATE INDEX events_ts ON events(ts);

CREATE TABLE event_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL,
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  count INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX event_summaries_agent ON event_summaries(agent_id, from_seq);

CREATE TABLE usage_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  subagent_id TEXT,
  ts INTEGER NOT NULL,
  model TEXT,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX usage_ts ON usage_samples(ts);
CREATE INDEX usage_agent ON usage_samples(agent_id);

CREATE TABLE review_comments (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  line INTEGER,
  body TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX review_comments_agent ON review_comments(agent_id, created_at);

CREATE TABLE review_viewed (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, path)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE ui_state (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  location TEXT NOT NULL,
  dir TEXT NOT NULL,
  dir_key TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  meta TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX artifacts_project ON artifacts(project_id, kind);

CREATE TABLE artifact_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  op TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX artifact_uses_artifact ON artifact_uses(artifact_id, ts);
CREATE INDEX artifact_uses_agent ON artifact_uses(agent_id, ts);

CREATE TABLE extensions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE custom_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE secrets (
  key TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'review comment side',
    // Which side of the diff a comment's line number refers to; existing comments were all new-side.
    up: `ALTER TABLE review_comments ADD COLUMN side TEXT NOT NULL DEFAULT 'new' CHECK (side IN ('old', 'new'));`,
  },
  {
    version: 3,
    name: 'archived agents',
    // Merged, discarded, completed and hand-archived agents keep their row, summary and events.
    // NULL archived_at = on the Wall. The summary's `archived` field mirrors these columns.
    up: `
ALTER TABLE agents ADD COLUMN archived_at INTEGER;
ALTER TABLE agents ADD COLUMN archive_reason TEXT CHECK (archive_reason IN ('merged', 'discarded', 'completed', 'archived-by-user'));
ALTER TABLE agents ADD COLUMN merge_commit TEXT;
CREATE INDEX agents_archived ON agents(archived_at DESC, id DESC) WHERE archived_at IS NOT NULL;
`,
  },
  {
    version: 4,
    name: 'daily usage rollup',
    // Token samples older than the retention window are summed into one row per local day,
    // project and model before they are deleted, so the Usage screen can show a year.
    // `day`: days since 1970-01-01 in local time at rollup; '' project / model = unknown.
    up: `
CREATE TABLE usage_daily (
  day INTEGER NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, project_id, model)
);
CREATE INDEX agents_created ON agents(created_at);
`,
  },
];
