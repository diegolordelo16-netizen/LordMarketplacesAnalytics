CREATE TABLE campaign_budget_executions (
 id TEXT PRIMARY KEY,
 proposal_id TEXT NOT NULL UNIQUE REFERENCES campaign_change_proposals(id) ON DELETE CASCADE,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 campaign_ref TEXT NOT NULL,
 before_cents INTEGER NOT NULL,
 target_cents INTEGER NOT NULL,
 source_path TEXT NOT NULL,
 document_nonce TEXT NOT NULL,
 token_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('CLAIMED','CANCELLED','FAILED','NEEDS_VERIFICATION','UI_READBACK_MATCHED')),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 result_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_campaign_budget_execution_account ON campaign_budget_executions(account_id,status);
