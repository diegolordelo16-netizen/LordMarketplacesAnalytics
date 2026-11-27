ALTER TABLE customer_voice_items ADD COLUMN external_listing_id TEXT;
CREATE INDEX idx_voc_external_listing ON customer_voice_items(account_id,external_listing_id);
