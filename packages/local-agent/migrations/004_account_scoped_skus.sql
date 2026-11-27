-- 004 — SKU explicitamente vinculado à conta para isolamento multi-loja.
ALTER TABLE skus ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE;
UPDATE skus
   SET account_id = (
     SELECT p.account_id FROM catalog_products p
      WHERE p.id = skus.catalog_product_id
   )
 WHERE account_id IS NULL AND catalog_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_skus_account ON skus(account_id, sku_code);

-- SKUs antigos sem produto, mas usados por anúncios de uma única conta, podem ser
-- associados com segurança. Em caso de uso por várias contas, permanecem sem inferência.
UPDATE skus
   SET account_id = (
     SELECT MIN(l.account_id) FROM listings l WHERE l.sku_id = skus.id
   )
 WHERE account_id IS NULL
   AND catalog_product_id IS NULL
   AND (SELECT COUNT(DISTINCT l.account_id) FROM listings l WHERE l.sku_id = skus.id) = 1;
