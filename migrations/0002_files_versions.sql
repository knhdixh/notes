-- Versions let two devices detect each other's edits; files are stored in D1 in 1 MB chunks.
ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE entries ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX files_created ON files(created_at DESC);

CREATE TABLE file_chunks (
  file_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, idx)
);

-- Which note ('note:<id>') or diary day ('day:<YYYY-MM-DD>') mentions a file.
CREATE TABLE file_refs (
  ref TEXT NOT NULL,
  file_id TEXT NOT NULL,
  PRIMARY KEY (ref, file_id)
);
CREATE INDEX file_refs_file ON file_refs(file_id);
