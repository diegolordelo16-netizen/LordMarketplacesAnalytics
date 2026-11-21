/**
 * Testes do protocolo: o contrato que separa extensão e serviço local.
 *
 * Cada teste aqui protege uma regra que, se quebrar, faz o produto mentir
 * (aceitar payload inválido, estourar limite, gerar envelope sem correlação).
 */
import { describe, expect, it } from "vitest";
import {
  Envelope,
  HandshakeRequest,
  PAYLOAD_LIMITS,
  PROTOCOL_VERSION,
  exceedsLimit,
  makeEnvelope,
  makeError,
  measurePayload,
} from "../src/index.js";

const UUID = "6f1a1e0c-8a3b-4c2d-9e7f-1a2b3c4d5e6f";

describe("envelope", () => {
  it("cria envelope válido com todos os campos obrigatórios", () => {
    const env = makeEnvelope("REQUEST", "system", { action: "system.ping" });
    expect(() => Envelope.parse(env)).not.toThrow();
    expect(env.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(env.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(env.timestamp).toISOString()).toBe(env.timestamp);
  });

  it("rejeita envelope sem correlationId", () => {
    const env = makeEnvelope("REQUEST", "system", {});
    const broken = { ...env, correlationId: undefined };
    expect(Envelope.safeParse(broken).success).toBe(false);
  });

  it("rejeita tipo desconhecido e namespace desconhecido", () => {
    const env = makeEnvelope("REQUEST", "system", {});
    expect(Envelope.safeParse({ ...env, type: "COMMAND" }).success).toBe(false);
    expect(Envelope.safeParse({ ...env, namespace: "pagamentos" }).success).toBe(false);
  });

  it("makeError mantém o correlationId da requisição original", () => {
    const err = makeError("NOT_IMPLEMENTED", "sem handler", UUID);
    expect(err.type).toBe("ERROR");
    expect(err.correlationId).toBe(UUID);
    expect((err.payload as { code: string }).code).toBe("NOT_IMPLEMENTED");
  });
});

describe("limites de payload", () => {
  it("mede bytes UTF-8, não caracteres", () => {
    // "ção" tem 3 caracteres; serializado em JSON vira "\u00e7\u00e3o" com 7 bytes.
    // O que importa: a medida é em bytes, nunca em caracteres.
    expect(measurePayload("ção")).toBe(7);
    expect(measurePayload("ção")).toBeGreaterThan("ção".length);
  });

  it("não bloqueia payload pequeno e bloqueia acima do limite do namespace", () => {
    const small = { action: "system.ping" };
    expect(exceedsLimit("system", small)).toBe(false);
    const huge = { blob: "x".repeat(PAYLOAD_LIMITS.system + 10) };
    expect(exceedsLimit("system", huge)).toBe(true);
  });

  it("capture tem limite maior que system", () => {
    expect(PAYLOAD_LIMITS.capture).toBeGreaterThan(PAYLOAD_LIMITS.system);
  });
});

describe("handshake", () => {
  it("exige token com tamanho mínimo", () => {
    expect(
      HandshakeRequest.safeParse({
        token: "curto",
        clientVersion: "0.1.0",
        protocolVersion: PROTOCOL_VERSION,
      }).success,
    ).toBe(false);
  });

  it("aceita handshake completo", () => {
    expect(
      HandshakeRequest.safeParse({
        token: "a".repeat(32),
        clientVersion: "0.1.0",
        protocolVersion: PROTOCOL_VERSION,
      }).success,
    ).toBe(true);
  });
});
