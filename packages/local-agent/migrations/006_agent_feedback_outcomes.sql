ALTER TABLE human_feedback ADD COLUMN outcome_json TEXT;
ALTER TABLE human_feedback ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'NOT_PROVIDED';
CREATE INDEX IF NOT EXISTS idx_human_feedback_decision_created ON human_feedback(decision, created_at DESC);
