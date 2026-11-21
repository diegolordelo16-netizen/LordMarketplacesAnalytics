/**
 * Testes da Central de Melhorias — a regra mais importante do produto.
 *
 * Se estes testes passarem por engano, qualquer sessão pareada poderia mudar
 * o software de forma permanente. Por isso testamos a recusa, não só o sucesso.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LocalDatabase } from "../src/database/db.js";
import { ImprovementService, OwnerRequiredError } from "../src/services/improvements.js";

let db: LocalDatabase;
let service: ImprovementService;
let ownerId: string;

beforeEach(() => {
  db = new LocalDatabase({ path: ":memory:" });
  service = new ImprovementService(db);
  ownerId = service.ensureOwner("Diego");
});

afterEach(() => db.close());

describe("dono", () => {
  test("ensureOwner é idempotente e cria um só", () => {
    const again = service.ensureOwner();
    assert.equal(again, ownerId);
    assert.equal(service.ownerId(), ownerId);
  });
});

describe("proposta", () => {
  test("qualquer sessão pode propor", () => {
    const imp = service.propose({
      title: "Ajustar seletor de preço",
      rationale: "A classe mudou e o preço passou a vir NOT_COLLECTED.",
      kind: "adapter",
      payload: { selector: "[data-testid='price']" },
    });
    assert.equal(imp.status, "PROPOSED");
    assert.equal(imp.decidedBy, null);
  });

  test("exige título e justificativa", () => {
    assert.throws(
      () => service.propose({ title: "", rationale: "x", kind: "rule", payload: {} }),
      /TITLE_REQUIRED/,
    );
    assert.throws(
      () => service.propose({ title: "x", rationale: "  ", kind: "rule", payload: {} }),
      /RATIONALE_REQUIRED/,
    );
  });
});

describe("decisão", () => {
  test("sessão sem identidade é recusada", () => {
    const imp = service.propose({ title: "t", rationale: "r", kind: "rule", payload: {} });
    assert.throws(() => service.approve(imp.id, null), OwnerRequiredError);
  });

  test("ator diferente do dono é recusado, mesmo com id válido", () => {
    const imp = service.propose({ title: "t", rationale: "r", kind: "rule", payload: {} });
    assert.throws(() => service.approve(imp.id, crypto.randomUUID()), OwnerRequiredError);
    assert.equal(service.get(imp.id)!.status, "PROPOSED");
  });

  test("o dono aprova e a decisão fica registrada com quem e quando", () => {
    const imp = service.propose({ title: "t", rationale: "r", kind: "rule", payload: {} });
    const approved = service.approve(imp.id, ownerId, "faz sentido");
    assert.equal(approved.status, "APPROVED");
    assert.equal(approved.decidedBy, ownerId);
    assert.ok(approved.decidedAt);
    assert.equal(approved.decisionNote, "faz sentido");
  });

  test("o dono rejeita", () => {
    const imp = service.propose({ title: "t", rationale: "r", kind: "ui", payload: {} });
    assert.equal(service.reject(imp.id, ownerId).status, "REJECTED");
  });

  test("não se decide duas vezes", () => {
    const imp = service.propose({ title: "t", rationale: "r", kind: "rule", payload: {} });
    service.approve(imp.id, ownerId);
    assert.throws(() => service.reject(imp.id, ownerId), /INVALID_TRANSITION/);
  });

  test("não se aplica o que não foi aprovado", () => {
    const imp = service.propose({ title: "t", rationale: "r", kind: "rule", payload: {} });
    assert.throws(() => service.markApplied(imp.id, ownerId), /INVALID_TRANSITION/);
    service.approve(imp.id, ownerId);
    assert.equal(service.markApplied(imp.id, ownerId).status, "APPLIED");
  });

  test("aplicar também exige o dono", () => {
    const imp = service.propose({ title: "t", rationale: "r", kind: "rule", payload: {} });
    service.approve(imp.id, ownerId);
    assert.throws(() => service.markApplied(imp.id, crypto.randomUUID()), OwnerRequiredError);
  });
});

describe("listagem", () => {
  test("filtra por status", () => {
    const a = service.propose({ title: "a", rationale: "r", kind: "rule", payload: {} });
    service.propose({ title: "b", rationale: "r", kind: "rule", payload: {} });
    service.approve(a.id, ownerId);
    assert.equal(service.list("PROPOSED").length, 1);
    assert.equal(service.list("APPROVED").length, 1);
    assert.equal(service.list().length, 2);
  });
});
