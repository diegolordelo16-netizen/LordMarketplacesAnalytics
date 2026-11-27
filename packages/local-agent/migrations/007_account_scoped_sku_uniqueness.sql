-- @requires_foreign_keys_off
-- 007 — Remove a antiga unicidade global e passa a proteger SKU por conta.
-- As FKs são desativadas apenas durante esta reconstrução transacional; o runner
-- valida PRAGMA foreign_key_check antes de registrar a migration e reativa as FKs.
CREATE TABLE skus_rebuilt (
  id TEXT PRIMARY KEY,
  catalog_product_id TEXT REFERENCES catalog_products(id),
  sku_code TEXT NOT NULL,
  ean TEXT,
  gtin TEXT,
  upc TEXT,
  attributes_json TEXT,
  created_at TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  UNIQUE(account_id, sku_code)
);

INSERT INTO skus_rebuilt (id, catalog_product_id, sku_code, ean, gtin, upc, attributes_json, created_at, account_id)
SELECT id, catalog_product_id, sku_code, ean, gtin, upc, attributes_json, created_at, account_id
  FROM skus;

DROP TABLE skus;
ALTER TABLE skus_rebuilt RENAME TO skus;

CREATE INDEX idx_skus_ean ON skus(ean);
CREATE INDEX idx_skus_account ON skus(account_id, sku_code);
