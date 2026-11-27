ALTER TABLE connector_sync_runs ADD COLUMN next_cursor TEXT;
ALTER TABLE connector_sync_runs ADD COLUMN previous_run_id TEXT REFERENCES connector_sync_runs(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_connector_continuation_once ON connector_sync_runs(previous_run_id) WHERE previous_run_id IS NOT NULL AND status='OK';
UPDATE connector_registry SET missing_fields='Leitura paginada de anúncios; não confirma vendas, estoque ou cobertura integral.' WHERE id IN('mercado_livre_official_api','shopee_official_api','amazon_sp_api');
UPDATE connector_registry SET limits='Exportação manual, 10000 observações por arquivo. API Trends alfa depende de acesso do Google.',missing_fields='API alfa não disponível neste build; exportação local com proveniência e índice relativo.',refresh_policy='Importação manual sob demanda' WHERE id='google_trends_public';
