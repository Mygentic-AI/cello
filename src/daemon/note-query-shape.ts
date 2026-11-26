// The two tables a note-query sees. This shape is what agents write their SQL against, so it stays as it is whatever the
// daemon's own tables become. Ids are lowercase hex text, and times are ISO-8601 text in UTC, which sorts and which
// SQLite's date functions read.
export const NOTES_COLUMNS = [
  "id", "agent_id", "written_by", "created_at", "updated_at", "kind", "status", "entity", "with_id", "session_id", "channel_id",
  "check_by", "rang_at", "expires_at", "show_at_start", "keep_history", "source", "body", "contact_removed",
] as const;
export const NOTE_CHANGES_COLUMNS = ["id", "note_id", "agent_id", "written_by", "changed_at", "source", "before"] as const;

export const QUERY_TABLES = `
CREATE TABLE notes (
  id TEXT, agent_id TEXT, written_by TEXT, created_at TEXT, updated_at TEXT, kind TEXT, status TEXT, entity TEXT,
  with_id TEXT, session_id TEXT, channel_id TEXT, check_by TEXT, rang_at TEXT, expires_at TEXT,
  show_at_start INTEGER, keep_history INTEGER, source TEXT, body TEXT, contact_removed INTEGER
);
CREATE TABLE note_changes (id INTEGER, note_id TEXT, agent_id TEXT, written_by TEXT, changed_at TEXT, source TEXT, before TEXT);
`;
