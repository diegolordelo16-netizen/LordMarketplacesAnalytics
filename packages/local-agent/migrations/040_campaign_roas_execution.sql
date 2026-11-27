ALTER TABLE campaign_budget_executions ADD COLUMN before_roas_target INTEGER
  CHECK(before_roas_target IS NULL OR (before_roas_target BETWEEN 100 AND 3500 AND before_campaign_status IS NULL));
ALTER TABLE campaign_budget_executions ADD COLUMN target_roas_target INTEGER
  CHECK((target_roas_target IS NULL AND before_roas_target IS NULL) OR
    (target_roas_target BETWEEN 100 AND 3500 AND before_roas_target IS NOT NULL AND before_roas_target<>target_roas_target
     AND before_cents=target_cents AND target_campaign_status IS NULL));
