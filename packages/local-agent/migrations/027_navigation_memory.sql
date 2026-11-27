CREATE TABLE navigation_memory (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  route TEXT NOT NULL,
  page_kind TEXT NOT NULL CHECK(page_kind IN ('seller_dashboard','seller_orders','seller_listings','seller_ads','seller_questions','seller_reputation','seller_returns','seller_complaints','seller_inventory')),
  observations INTEGER NOT NULL DEFAULT 1 CHECK(observations > 0),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(account_id,origin,route)
);
