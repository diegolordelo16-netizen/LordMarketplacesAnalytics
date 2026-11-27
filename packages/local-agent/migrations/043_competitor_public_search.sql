
CREATE TABLE competitor_public_search_observations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES competitor_search_runs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  own_product_id TEXT NOT NULL REFERENCES own_products(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES competitor_candidates(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  source_url TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  observed_order INTEGER NOT NULL CHECK(observed_order BETWEEN 1 AND 20),
  title TEXT NOT NULL,
  price_cents INTEGER CHECK(price_cents IS NULL OR price_cents>=0),
  sponsored INTEGER CHECK(sponsored IS NULL OR sponsored IN (0,1)),
  UNIQUE(run_id,candidate_id)
);
CREATE INDEX idx_comp_public_search_candidate ON competitor_public_search_observations(candidate_id,observed_at DESC);
