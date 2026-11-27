CREATE TABLE listing_api_executions (
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
  CHECK(status <> 'REMOTE_VERIFIED' OR variation_id IS NOT NULL)
);
CREATE INDEX idx_listing_api_account ON listing_api_executions(account_id, listing_id, status);
