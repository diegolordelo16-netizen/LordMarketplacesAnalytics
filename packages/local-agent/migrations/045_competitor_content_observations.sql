CREATE TABLE competitor_content_observations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  own_product_id TEXT NOT NULL REFERENCES own_products(id) ON DELETE CASCADE,
  candidate_id TEXT REFERENCES competitor_candidates(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK(side IN ('OWN','RIVAL')),
  source_class TEXT NOT NULL CHECK(source_class IN ('A_PRIMARY_UI','B_PLATFORM_EXPORT','F_USER_INPUT')),
  source_url TEXT,
  captured_at TEXT NOT NULL,
  description TEXT,
  promotions_json TEXT,
  images_json TEXT,
  CHECK((side='OWN' AND candidate_id IS NULL) OR (side='RIVAL' AND candidate_id IS NOT NULL)),
  CHECK(description IS NOT NULL OR promotions_json IS NOT NULL OR images_json IS NOT NULL)
);
CREATE INDEX idx_comp_content_latest ON competitor_content_observations(account_id,own_product_id,side,candidate_id,captured_at DESC,id);
