CREATE TABLE navigation_actions (
  account_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  route TEXT NOT NULL,
  action_kind TEXT NOT NULL CHECK(action_kind IN ('SPA_NEXT','FILTER_CHANGE')),
  observations INTEGER NOT NULL DEFAULT 1 CHECK(observations BETWEEN 1 AND 1000000),
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(account_id,origin,route,action_kind),
  FOREIGN KEY(account_id,origin,route) REFERENCES navigation_memory(account_id,origin,route) ON DELETE CASCADE
);
