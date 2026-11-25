/**
 * Credenciais de API dos marketplaces — opcionais, cifradas, nunca legíveis de
 * volta pelo painel.
 *
 * Decisões que este módulo encarna:
 *  1. SEM CHAVE, SEM GRAVAÇÃO. Se não houver LMA_API_SECRET_KEY (ou o arquivo
 *     local equivalente), o produto recusa gravar o segredo em vez de guardá-lo
 *     em texto puro. Texto puro em SQLite é pior que não ter o recurso.
 *  2. O PAINEL NUNCA VÊ O SEGREDO. A leitura devolve status, escopos e datas —
 *     jamais o valor. Quem precisa do segredo é o conector, no serviço local.
 *  3. STATUS HONESTO. Uma credencial gravada não é "funcionando": só depois de
 *     uma verificação real (chamada à API do marketplace) ela vira ACTIVE.
 *     Até lá é PENDING — selo honesto, não expectativa.
 *     Sem rede, o status continua o que era e o motivo fica registrado.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { applyApiCredentialsMigration } from "../database/migration-api-credentials.js";

export const API_MARKETPLACES = ["mercadolivre", "shopee", "amazon", "tiktokshop", "shein"] as const;
export type ApiMarketplace = (typeof API_MARKETPLACES)[number];

/**
 * PENDING: gravada, nunca verificada contra o marketplace.
 * ACTIVE: uma chamada real à API confirmou.
 * INVALID: a última verificação falhou.
 * REVOKED: o usuário revogou a credencial no portal.
 */
export type CredentialStatus = "PENDING" | "ACTIVE" | "INVALID" | "REVOKED";

export interface SaveCredentialInput {
  marketplace: ApiMarketplace;
  accountRef?: string | null;
  label: string;
  /** Campos não secretos da autenticação (app_id, client_id, seller_id...). */
  publicFields: Record<string, string>;
  /** O segredo: client_secret, access_token, refresh_token... */
  secret: string;
  scopes?: string[];
}

/** O que o painel recebe — nunca inclui o segredo. */
export interface CredentialView {
  id: string;
  marketplace: ApiMarketplace;
  accountRef: string | null;
  label: string;
  publicFields: Record<string, string>;
  scopes: string[];
  status: CredentialStatus;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  lastError: string | null;
  hasSecret: boolean;
}

export class MissingEncryptionKeyError extends Error {
  readonly code = "ENCRYPTION_KEY_MISSING";
  constructor() {
    super(
      "Chave de criptografia ausente: defina LMA_API_SECRET_KEY (32 bytes em base64) ou gere pelo painel. " +
        "Sem ela, credencial de API não é gravada — o produto não guarda segredo em texto puro.",
    );
  }
}

export class CredentialValidationError extends Error {
  readonly code = "SCHEMA_VALIDATION_FAILED";
}

/** Deriva uma chave de 32 bytes a partir de um segredo textual (SHA-256). */
export function deriveKey(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

/** Chave nova, em base64, para o usuário guardar. */
export function generateKeyBase64(): string {
  return randomBytes(32).toString("base64");
}

/**
 * Cifra e decifra com AES-256-GCM. O GCM autentica: se alguém editar o banco,
 * a decifragem falha em vez de devolver lixo.
 */
export function encryptSecret(secret: string, key: Buffer): { cipher: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const cipher = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return {
    cipher: cipher.toString("base64"),
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(payload: { cipher: string; iv: string; tag: string }, key: Buffer): string {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  d.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(payload.cipher, "base64")), d.final()]).toString("utf8");
}

export interface ApiCredentialServiceOptions {
  db: DatabaseSync;
  /** Chave em Buffer, ou null quando o usuário ainda não tem uma. */
  key: Buffer | null;
  now?: () => Date;
  audit?: { append: (kind: string, detail: Record<string, unknown>) => void };
}

export class ApiCredentialService {
  private readonly db: DatabaseSync;
  private readonly key: Buffer | null;
  private readonly now: () => Date;
  private readonly audit?: ApiCredentialServiceOptions["audit"];

  constructor(options: ApiCredentialServiceOptions) {
    this.db = options.db;
    this.key = options.key;
    this.now = options.now ?? (() => new Date());
    this.audit = options.audit;
    applyApiCredentialsMigration(this.db);
  }

  get encryptionAvailable(): boolean {
    return this.key !== null;
  }

  list(): CredentialView[] {
    const rows = this.db
      .prepare(`SELECT * FROM api_credentials ORDER BY marketplace, label`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.toView(r));
  }

  listFor(marketplace: ApiMarketplace): CredentialView[] {
    return this.list().filter((c) => c.marketplace === marketplace);
  }

  /** Grava (ou substitui) a credencial de API de um marketplace/conta. */
  save(input: SaveCredentialInput): CredentialView {
    if (!this.key) throw new MissingEncryptionKeyError();
    this.validate(input);

    const accountRef = input.accountRef?.trim() || null;
    const encrypted = encryptSecret(input.secret.trim(), this.key);
    const now = this.now().toISOString();

    const existing = this.db
      .prepare(`SELECT id FROM api_credentials WHERE marketplace = ? AND account_ref IS ?`)
      .get(input.marketplace, accountRef) as { id: string } | undefined;

    const id = existing?.id ?? crypto.randomUUID();
    if (existing) {
      this.db
        .prepare(
          `UPDATE api_credentials
              SET label = ?, public_fields = ?, secret_cipher = ?, secret_iv = ?, secret_tag = ?,
                  scopes = ?, status = 'PENDING', last_verified_at = NULL,
                  updated_at = ?, last_error = NULL
            WHERE id = ?`,
        )
        .run(
          input.label.trim(),
          JSON.stringify(input.publicFields),
          encrypted.cipher,
          encrypted.iv,
          encrypted.tag,
          JSON.stringify(input.scopes ?? []),
          now,
          id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO api_credentials
             (id, marketplace, account_ref, label, public_fields, secret_cipher, secret_iv, secret_tag,
              scopes, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        )
        .run(
          id,
          input.marketplace,
          accountRef,
          input.label.trim(),
          JSON.stringify(input.publicFields),
          encrypted.cipher,
          encrypted.iv,
          encrypted.tag,
          JSON.stringify(input.scopes ?? []),
          now,
          now,
        );
    }

    this.audit?.append("api_credential_saved", {
      id,
      marketplace: input.marketplace,
      accountRef,
      // Nem o segredo, nem seu tamanho: só o fato de ter sido gravado.
    });
    return this.get(id) as CredentialView;
  }

  get(id: string): CredentialView | null {
    const row = this.db.prepare(`SELECT * FROM api_credentials WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toView(row) : null;
  }

  /** Remove a credencial. O segredo cifrado deixa de existir no banco. */
  remove(id: string): boolean {
    const view = this.get(id);
    if (!view) return false;
    this.db.prepare(`DELETE FROM api_credentials WHERE id = ?`).run(id);
    this.audit?.append("api_credential_removed", { id, marketplace: view.marketplace });
    return true;
  }

  /**
   * Marca o resultado de uma verificação real. Só o conector chama isto, e só
   * depois de falar de verdade com a API do marketplace.
   */
  markVerified(id: string, result: { ok: boolean; error?: string }): CredentialView | null {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE api_credentials
            SET status = ?, last_verified_at = ?, last_error = ?
          WHERE id = ?`,
      )
      .run(result.ok ? "ACTIVE" : "INVALID", now, result.error ?? null, id);
    this.audit?.append("api_credential_verified", { id, ok: result.ok });
    return this.get(id);
  }

  /**
   * Uso interno: o conector pede o segredo para autenticar. Nunca exposto ao
   * painel — o envelope do protocolo não tem ação que devolva isto.
   */
  revealSecretForConnector(id: string): string | null {
    if (!this.key) throw new MissingEncryptionKeyError();
    const row = this.db
      .prepare(`SELECT secret_cipher, secret_iv, secret_tag FROM api_credentials WHERE id = ?`)
      .get(id) as { secret_cipher: string | null; secret_iv: string | null; secret_tag: string | null } | undefined;
    if (!row?.secret_cipher || !row.secret_iv || !row.secret_tag) return null;
    return decryptSecret({ cipher: row.secret_cipher, iv: row.secret_iv, tag: row.secret_tag }, this.key);
  }

  // -------------------------------------------------------------- internos

  private validate(input: SaveCredentialInput): void {
    if (!API_MARKETPLACES.includes(input.marketplace)) {
      throw new CredentialValidationError(`marketplace sem conector: ${String(input.marketplace)}`);
    }
    if (!input.label?.trim()) throw new CredentialValidationError("label é obrigatório");
    if (!input.secret?.trim()) throw new CredentialValidationError("segredo é obrigatório");
    if (input.secret.trim().length < 8) {
      throw new CredentialValidationError("segredo curto demais para ser um token de API");
    }
  }

  private toView(row: Record<string, unknown>): CredentialView {
    return {
      id: String(row.id),
      marketplace: String(row.marketplace) as ApiMarketplace,
      accountRef: row.account_ref === null ? null : String(row.account_ref),
      label: String(row.label),
      publicFields: safeJson<Record<string, string>>(row.public_fields, {}),
      scopes: safeJson<string[]>(row.scopes, []),
      status: String(row.status) as CredentialStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastVerifiedAt: row.last_verified_at === null ? null : String(row.last_verified_at),
      lastError: row.last_error === null ? null : String(row.last_error),
      hasSecret: Boolean(row.secret_cipher),
    };
  }
}

function safeJson<T>(raw: unknown, fallback: T): T {
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

/** Catálogo dos conectores: o que cada marketplace exige, segundo a doc deles. */
export interface ConnectorField {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  hint: string;
}

export interface ConnectorSpec {
  marketplace: ApiMarketplace;
  name: string;
  /** Como obter as credenciais, nas palavras do marketplace. */
  howTo: string;
  authType: string;
  docsUrl: string;
  fields: ConnectorField[];
}

export const CONNECTORS: ConnectorSpec[] = [
  {
    marketplace: "mercadolivre",
    name: "Mercado Livre",
    authType: "OAuth 2.0 (app do Mercado Livre Developers)",
    howTo:
      "Crie uma aplicação em developers.mercadolivre.com.br, pegue o App ID e a Secret Key. O access_token expira em 6 horas; o refresh_token renova automaticamente.",
    docsUrl: "https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao",
    fields: [
      { key: "app_id", label: "App ID", required: true, secret: false, hint: "número do app" },
      { key: "seller_id", label: "Seller ID", required: false, secret: false, hint: "seu id de vendedor" },
      { key: "access_token", label: "Access token", required: true, secret: true, hint: "APP_USR-..." },
      { key: "refresh_token", label: "Refresh token", required: false, secret: true, hint: "TG-..." },
    ],
  },
  {
    marketplace: "shopee",
    name: "Shopee",
    authType: "OAuth 2.0 (Shopee Open Platform)",
    howTo:
      "Registre o app no Shopee Open Platform, gere o partner_id e a partner_key. O shop_id vem depois da autorização da loja.",
    docsUrl: "https://open.shopee.com/documents",
    fields: [
      { key: "partner_id", label: "Partner ID", required: true, secret: false, hint: "id do app" },
      { key: "shop_id", label: "Shop ID", required: false, secret: false, hint: "id da loja" },
      { key: "partner_key", label: "Partner key", required: true, secret: true, hint: "chave do app" },
      { key: "access_token", label: "Access token", required: false, secret: true, hint: "gerado por autorização" },
    ],
  },
  {
    marketplace: "amazon",
    name: "Amazon Seller Central",
    authType: "LWA + SP-API (Amazon Selling Partner API)",
    howTo:
      "No Seller Central, em Apps and Services, registre um app SP-API. Você recebe o LWA client_id e client_secret e precisa do refresh_token da autorização.",
    docsUrl: "https://developer-docs.amazon.com/sp-api/",
    fields: [
      { key: "client_id", label: "LWA client ID", required: true, secret: false, hint: "amzn1.application-oa2-client..." },
      { key: "seller_id", label: "Seller ID", required: false, secret: false, hint: "A1..." },
      { key: "client_secret", label: "LWA client secret", required: true, secret: true, hint: "amzn1.oa2-cs..." },
      { key: "refresh_token", label: "Refresh token", required: true, secret: true, hint: "Atzr|..." },
    ],
  },
  {
    marketplace: "tiktokshop",
    name: "TikTok Shop",
    authType: "OAuth 2.0 (TikTok Shop Partner Center)",
    howTo:
      "No TikTok Shop Partner Center, crie um app e obtenha o app_key e o app_secret. O access_token vem da autorização da loja.",
    docsUrl: "https://partner.tiktokshop.com/doc",
    fields: [
      { key: "app_key", label: "App key", required: true, secret: false, hint: "chave do app" },
      { key: "shop_cipher", label: "Shop cipher", required: false, secret: false, hint: "loja autorizada" },
      { key: "app_secret", label: "App secret", required: true, secret: true, hint: "segredo do app" },
      { key: "access_token", label: "Access token", required: false, secret: true, hint: "gerado por autorização" },
    ],
  },
  {
    marketplace: "shein",
    name: "Shein (SHEIN Open Platform)",
    authType: "OAuth 2.0 (SHEIN Open Platform)",
    howTo:
      "Peça acesso ao SHEIN Open Platform, crie o app e copie o app_id e o app_secret. A autorização da loja devolve o access_token.",
    docsUrl: "https://openapi.sheincorp.com/",
    fields: [
      { key: "app_id", label: "App ID", required: true, secret: false, hint: "id do app" },
      { key: "supplier_id", label: "Supplier / store id", required: false, secret: false, hint: "id da loja" },
      { key: "app_secret", label: "App secret", required: true, secret: true, hint: "segredo do app" },
      { key: "access_token", label: "Access token", required: false, secret: true, hint: "gerado por autorização" },
    ],
  },
];
