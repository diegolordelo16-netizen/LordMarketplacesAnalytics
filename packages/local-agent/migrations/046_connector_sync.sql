CREATE TABLE connector_sync_runs (
 id TEXT PRIMARY KEY, connector_id TEXT NOT NULL REFERENCES connector_registry(id), account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 scope_key TEXT NOT NULL, kind TEXT NOT NULL, period_start TEXT, period_end TEXT, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
 status TEXT NOT NULL, partial INTEGER NOT NULL CHECK(partial IN(0,1)), row_count INTEGER NOT NULL CHECK(row_count>=0), request_count INTEGER NOT NULL CHECK(request_count>=0), note TEXT NOT NULL
);
CREATE INDEX idx_connector_sync_scope ON connector_sync_runs(account_id,connector_id,scope_key,finished_at DESC);
CREATE TABLE connector_sync_rows (run_id TEXT NOT NULL REFERENCES connector_sync_runs(id) ON DELETE CASCADE,row_key TEXT NOT NULL,reference_date TEXT,values_json TEXT NOT NULL,PRIMARY KEY(run_id,row_key));
CREATE TABLE connector_request_log (id TEXT PRIMARY KEY,connector_id TEXT NOT NULL REFERENCES connector_registry(id),requested_at TEXT NOT NULL,operation TEXT NOT NULL);
CREATE INDEX idx_connector_requests ON connector_request_log(connector_id,requested_at);
UPDATE connector_registry SET missing_fields='Leitura diária da propriedade web; requer credenciais autorizadas. Não representa KPIs de marketplace.',refresh_policy='Sincronização sob demanda, janela incremental com sobreposição',limits='30 requisições locais por 24h; 5 por operação; cotas do provedor adicionais' WHERE id IN('google_analytics4','google_search_console');
UPDATE connector_registry SET missing_fields='Leitura limitada à primeira página de anúncios; não confirma vendas, estoque ou cobertura integral.',refresh_policy='Sob demanda, somente leitura',limits='30 requisições locais por 24h; 5 por operação; cotas do provedor adicionais' WHERE id IN('mercado_livre_official_api','shopee_official_api','amazon_sp_api');
