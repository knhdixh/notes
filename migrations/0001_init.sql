-- Single-owner app: no users table; Cloudflare Access + the Worker gate every request.

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  words INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  trashed_at INTEGER
);
CREATE INDEX notes_updated ON notes(trashed_at, pinned DESC, updated_at DESC);

CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX note_tags_tag ON note_tags(tag);

-- One diary entry per local day. `completed` is set only when the goal is reached on that day.
CREATE TABLE entries (
  day TEXT PRIMARY KEY,
  body TEXT NOT NULL DEFAULT '',
  words INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
