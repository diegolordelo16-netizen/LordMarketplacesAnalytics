-- 003 — Workspace operational features: media library and account/user administration metadata.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS media_library (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','image/gif')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  sha256 TEXT NOT NULL,
  content_base64 TEXT NOT NULL,
  alt_text TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_account ON media_library(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS connector_states (
  connector_id TEXT PRIMARY KEY REFERENCES connector_registry(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
