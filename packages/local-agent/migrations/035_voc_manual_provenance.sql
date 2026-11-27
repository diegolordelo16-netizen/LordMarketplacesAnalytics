UPDATE customer_voice_items
SET source_class='F_USER_INPUT'
WHERE source_class='A_PRIMARY_UI' AND EXISTS (
  SELECT 1 FROM audit_log
  WHERE entity='customer_voice_item' AND entity_id=customer_voice_items.id
    AND action='VOC_INGEST' AND result='OK'
);
