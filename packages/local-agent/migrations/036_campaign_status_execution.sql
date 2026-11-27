ALTER TABLE campaign_budget_executions ADD COLUMN before_campaign_status TEXT
  CHECK(before_campaign_status IS NULL OR before_campaign_status IN ('ACTIVE','PAUSED'));
ALTER TABLE campaign_budget_executions ADD COLUMN target_campaign_status TEXT
  CHECK((target_campaign_status IS NULL AND before_campaign_status IS NULL)
    OR (target_campaign_status IS NOT NULL AND target_campaign_status IN ('ACTIVE','PAUSED') AND before_campaign_status IS NOT NULL
      AND before_campaign_status<>target_campaign_status AND before_cents=target_cents));
