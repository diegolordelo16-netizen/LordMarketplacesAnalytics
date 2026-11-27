CREATE TABLE listing_change_proposals (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('COVER','DUPLICATE')),
 media_id TEXT REFERENCES media_library(id) ON DELETE SET NULL,
 media_sha256 TEXT,
 baseline_snapshot_id TEXT NOT NULL REFERENCES listing_snapshots(id) ON DELETE CASCADE,
 reason TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','REJECTED')),
 created_by TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 approved_by TEXT,
 approved_at TEXT
);
CREATE INDEX idx_listing_change_proposals_account ON listing_change_proposals(account_id,created_at DESC);
CREATE TABLE operation_manual_receipts (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 proposal_kind TEXT NOT NULL CHECK(proposal_kind IN ('CAMPAIGN','VARIATION','LISTING_CHANGE')),
 proposal_id TEXT NOT NULL,
 performed_at TEXT NOT NULL,
 evidence_reference TEXT NOT NULL,
 reported_by TEXT NOT NULL,
 reported_at TEXT NOT NULL,
 UNIQUE(proposal_kind,proposal_id)
);
CREATE INDEX idx_operation_manual_receipts_account ON operation_manual_receipts(account_id,reported_at DESC);
