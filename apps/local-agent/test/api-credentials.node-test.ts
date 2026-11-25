/**
 * Testes das credenciais de API dos marketplaces.
 *
 * O que está protegido aqui, porque é o que pode dar errado de verdade:
 *  - segredo NUNCA gravado em texto puro no banco;
 *  - sem chave de criptografia, a gravação é RECUSADA (não cai para plaintext);
 *  - a resposta ao painel nunca contém o segredo;
 *  - chave errada falha ao decifrar (GCM autentica; editar o banco não passa);
 *  - credencial gravada não vira "verificada" sozinha.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalDatabase } from "../src/database/db.js";
import {
  ApiCredentialService,
  MissingEncryptionKeyError,
  CONNECTORS,
  decryptSecret,
  deriveKey,
  encryptSecret,
} from "../src/services/api-credentials.js";

const SECRET = "APP_USR-1234567890-super-secreto-do-mercado-livre";
let dir: string;
let db: LocalDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lma-cred-"));
  db = new LocalDatabase({ path: join(dir, "t.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function service(key: string | null) {
  return new ApiCredentialService({ db: db.raw(), key: key ? deriveKey(key) : null });
}

describe("criptografia", () => {
  test("cifra e decifra de volta ao original", () => {
    const key = deriveKey("minha-chave-de-teste");
    const enc = encryptSecret(SECRET, key);
    assert.notEqual(enc.cipher, SECRET);
    assert.equal(decryptSecret(enc, key), SECRET);
  });

  test("chave diferente nao decifra: o GCM autentica", () => {
    const enc = encryptSecret(SECRET, deriveKey("chave-certa"));
    assert.throws(() => decryptSecret(enc, deriveKey("chave-errada")));
  });

  test("mesmo texto cifra diferente (IV aleatorio)", () => {
    const key = deriveKey("k");
    assert.notEqual(encryptSecret(SECRET, key).cipher, encryptSecret(SECRET, key).cipher);
  });
});

describe("gravacao", () => {
  test("sem chave, recusa gravar em vez de guardar em texto puro", () => {
    const s = service(null);
    assert.equal(s.encryptionAvailable, false);
    assert.throws(() => s.save({ marketplace: "mercadolivre", label: "minha loja", publicFields: {}, secret: SECRET }), MissingEncryptionKeyError);
  });

  test("com chave, grava e nao devolve o segredo na leitura", () => {
    const s = service("chave-local");
    const view = s.save({ marketplace: "mercadolivre", label: "minha loja", publicFields: { app_id: "123" }, secret: SECRET });
    assert.equal(view.hasSecret, true);
    assert.equal(view.status, "ACTIVE");
    assert.equal(JSON.stringify(view).includes(SECRET), false, "o segredo nao pode aparecer na resposta");
  });

  test("o banco nao contem o segredo em texto puro", () => {
    const s = service("chave-local");
    s.save({ marketplace: "mercadolivre", label: "loja", publicFields: {}, secret: SECRET });
    const row = db.raw().prepare(`SELECT secret_cipher FROM api_credentials`).get() as { secret_cipher: string };
    assert.equal(row.secret_cipher.includes(SECRET), false);
  });

  test("segredo curto demais e recusado", () => {
    const s = service("k");
    assert.throws(() => s.save({ marketplace: "shopee", label: "x", publicFields: {}, secret: "abc" }), /curto demais/);
  });

  test("marketplace desconhecido e recusado", () => {
    const s = service("k");
    assert.throws(() => s.save({ marketplace: "magalu" as never, label: "x", publicFields: {}, secret: SECRET }), /sem conector/);
  });

  test("regravar a mesma conta substitui, nao duplica", () => {
    const s = service("k");
    s.save({ marketplace: "mercadolivre", accountRef: "loja-1", label: "v1", publicFields: {}, secret: SECRET });
    s.save({ marketplace: "mercadolivre", accountRef: "loja-1", label: "v2", publicFields: {}, secret: SECRET });
    const all = s.list();
    assert.equal(all.length, 1);
    assert.equal(all[0].label, "v2");
  });

  test("remover apaga a linha do banco", () => {
    const s = service("k");
    const view = s.save({ marketplace: "shopee", label: "loja", publicFields: {}, secret: SECRET });
    assert.equal(s.remove(view.id), true);
    assert.equal(s.list().length, 0);
    assert.equal(s.remove("nao-existe"), false);
  });
});

describe("status honesto", () => {
  test("credencial gravada nao nasce verificada", () => {
    const s = service("k");
    const view = s.save({ marketplace: "mercadolivre", label: "loja", publicFields: {}, secret: SECRET });
    assert.equal(view.lastVerifiedAt, null);
  });

  test("verificacao com falha marca INVALID e guarda o motivo", () => {
    const s = service("k");
    const view = s.save({ marketplace: "mercadolivre", label: "loja", publicFields: {}, secret: SECRET });
    const after = s.markVerified(view.id, { ok: false, error: "401 do marketplace" });
    assert.equal(after?.status, "INVALID");
    assert.equal(after?.lastError, "401 do marketplace");
  });
});

describe("catalogo de conectores", () => {
  test("todo marketplace tem acao obrigatoria e link de documentacao", () => {
    for (const c of CONNECTORS) {
      assert.ok(c.howTo.length > 20, `${c.marketplace} sem instrucao`);
      assert.match(c.docsUrl, /^https:\/\//);
      assert.ok(c.fields.some((f) => f.required), `${c.marketplace} sem campo obrigatorio`);
      assert.ok(c.fields.some((f) => f.secret), `${c.marketplace} sem campo secreto`);
    }
  });

  test("os cinco marketplaces do plano estao no catalogo", () => {
    const ids = CONNECTORS.map((c) => c.marketplace).sort();
    assert.deepEqual(ids, ["amazon", "mercadolivre", "shein", "shopee", "tiktokshop"]);
  });
});
