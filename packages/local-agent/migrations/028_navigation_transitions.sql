CREATE TABLE navigation_transitions (
  account_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  from_route TEXT NOT NULL,
  to_route TEXT NOT NULL,
  observations INTEGER NOT NULL DEFAULT 1 CHECK(observations BETWEEN 1 AND 1000000),
  last_seen_at TEXT NOT NULL,
  CHECK(from_route <> to_route),
  PRIMARY KEY(account_id,origin,from_route,to_route),
  FOREIGN KEY(account_id,origin,from_route) REFERENCES navigation_memory(account_id,origin,route) ON DELETE CASCADE,
  FOREIGN KEY(account_id,origin,to_route) REFERENCES navigation_memory(account_id,origin,route) ON DELETE CASCADE
);
