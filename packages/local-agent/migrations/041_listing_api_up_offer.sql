CREATE TABLE listing_api_executions_next (
  proposal_id TEXT PRIMARY KEY REFERENCES offer_variation_proposals(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  variation_id TEXT,
  price_cents INTEGER NOT NULL CHECK(price_cents>0),
  stock INTEGER NOT NULL CHECK(stock>=0),
  status TEXT NOT NULL CHECK(status IN ('DISPATCHED','NEEDS_VERIFICATION','REMOTE_VERIFIED')),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'CREATE_VARIATION' CHECK(action IN ('CREATE_VARIATION','REMOVE_VARIATION','EDIT_VARIATION','CREATE_UP_OFFER')),
  CHECK(status <> 'REMOTE_VERIFIED' OR variation_id IS NOT NULL)
);
INSERT INTO listing_api_executions_next (proposal_id,account_id,listing_id,seller_id,item_id,variation_id,price_cents,stock,status,started_at,updated_at,action)
SELECT proposal_id,account_id,listing_id,seller_id,item_id,variation_id,price_cents,stock,status,started_at,updated_at,action FROM listing_api_executions;
DROP TABLE listing_api_executions;
ALTER TABLE listing_api_executions_next RENAME TO listing_api_executions;
CREATE INDEX idx_listing_api_account ON listing_api_executions(account_id,listing_id,status);
