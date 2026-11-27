-- 044: aprendizagem observacional por loja e agente, sem misturar playbooks legados.
ALTER TABLE validated_playbooks ADD COLUMN account_id TEXT REFERENCES accounts(id);
ALTER TABLE validated_playbooks ADD COLUMN agent_key TEXT;
ALTER TABLE validated_playbooks ADD COLUMN action_key TEXT;
ALTER TABLE validated_playbooks ADD COLUMN observation_status TEXT NOT NULL DEFAULT 'LEGACY_UNSCOPED';
CREATE UNIQUE INDEX idx_playbooks_scoped_action ON validated_playbooks(account_id,agent_key,action_key) WHERE account_id IS NOT NULL AND agent_key IS NOT NULL AND action_key IS NOT NULL;
CREATE INDEX idx_feedback_latest ON human_feedback(recommendation_id,created_at DESC);
CREATE INDEX idx_debate_account_user ON debate_sessions(account_id,user_id,started_at DESC);
