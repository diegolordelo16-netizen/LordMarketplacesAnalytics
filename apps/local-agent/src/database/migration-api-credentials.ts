/**
 * Segunda migração: credenciais de API dos marketplaces (opcionais).
 *
 * Por que existe: o produto funciona inteiro sem API — ele lê o painel já
 * autenticado no navegador do usuário. A API é um acréscimo: quando o usuário
 * tem app registrado no marketplace, ela dá dado oficial (pedido confirmado,
 * estoque oficial) em vez de tela lida.
 *
 * Regras de segurança que o schema impõe:
 *  - o segredo NUNCA é gravado em texto: guarda-se o ciphertext, o IV e o tag;
 *  - o segredo nunca é devolvido ao painel: só o status (configurado ou não);
 *  - fica registrado quem gravou e quando, na auditoria encadeada.
 *
 * Chave de criptografia: variável de ambiente LMA_API_SECRET_KEY (32 bytes em
 * base64) OU arquivo local na pasta de configuração. Sem a chave, a credencial
 * não pode ser gravada — nunca cai para texto puro.
 */
import type { DatabaseSync } from "node:sqlite";

export const MIGRATION_API_CREDENTIALS = `
BEGIN;

CREATE TABLE IF NOT EXISTS api_credentials (
  id             TEXT PRIMARY KEY,
  marketplace    TEXT NOT NULL,
  -- Conta/loja a que a credencial pertence; NULL = a determinar.
  account_ref    TEXT,
  -- Nome amigável mostrado no painel (nunca inclui o segredo).
  label          TEXT NOT NULL,
  -- Campos públicos da autenticação (ex.: app_id, client_id) — não é segredo.
  public_fields  TEXT NOT NULL DEFAULT '{}',
  -- Segredo cifrado: AES-256-GCM. Os três campos andam juntos.
  secret_cipher  TEXT,
  secret_iv      TEXT,
  secret_tag     TEXT,
  -- Escopos concedidos no marketplace, em JSON.
  scopes         TEXT NOT NULL DEFAULT '[]',
  -- PENDING é o estado honesto de uma credencial recém-gravada: nenhuma
  -- chamada ao marketplace a confirmou ainda.
  status         TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVE','INVALID','REVOKED')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_verified_at TEXT,
  last_error     TEXT,
  UNIQUE (marketplace, account_ref)
);

CREATE INDEX IF NOT EXISTS ix_api_credentials_marketplace
  ON api_credentials(marketplace, status);

-- Registro do que a API trouxe, para o painel poder comparar com a captura
-- de tela. Mesmo formato de proveniência do dado capturado, com source='api'.
-- (Usa a tabela data_points existente; nada a criar aqui.)

COMMIT;
`;

export function applyApiCredentialsMigration(db: DatabaseSync): void {
  db.exec(MIGRATION_API_CREDENTIALS);
}
