ALTER TABLE listing_snapshots
  ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '{}';
