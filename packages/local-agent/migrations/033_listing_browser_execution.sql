CREATE TABLE listing_browser_executions (
 id TEXT PRIMARY KEY,
 proposal_kind TEXT NOT NULL CHECK(proposal_kind IN ('VARIATION','LISTING_CHANGE')),
 proposal_id TEXT NOT NULL,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
 external_listing_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('DUPLICATE','CREATE_VARIATION','EDIT_VARIATION')),
 plan_json TEXT NOT NULL,
 context_json TEXT NOT NULL,
 token_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('CLAIMED','CANCELLED','FAILED','NEEDS_VERIFICATION','UI_READBACK_MATCHED','CANDIDATE_OBSERVED')),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 result_json TEXT NOT NULL DEFAULT '{}',
 UNIQUE(proposal_kind,proposal_id)
);
CREATE INDEX idx_listing_browser_execution_scope ON listing_browser_executions(account_id,listing_id,status);
