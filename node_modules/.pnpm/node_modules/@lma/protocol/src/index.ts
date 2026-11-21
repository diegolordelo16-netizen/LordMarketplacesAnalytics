/**
 * Protocolo único de mensagens entre extensão e serviço local.
 *
 * O transporte muda (loopback WebSocket no desenvolvimento, Native Messaging
 * na produção), mas o envelope nunca muda: nenhum módulo de negócio conhece
 * o transporte, só recebe e devolve envelopes.
 *
 * Regra de integridade: mensagem inválida é rejeitada com ERROR e auditada.
 * Nunca existe "melhor esforço" silencioso.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = "1.0.0";

/** Tipos de mensagem do envelope. */
export const MessageType = z.enum([
  "REQUEST",
  "RESPONSE",
  "EVENT",
  "STREAM_CHUNK",
  "ERROR",
]);
export type MessageType = z.infer<typeof MessageType>;

/** Namespaces de módulo — cada um tem seus próprios schemas de payload. */
export const Namespace = z.enum([
  "system",
  "capture",
  "adapter",
  "kpi",
  "finance",
  "agent",
  "gemini",
  "improvement",
]);
export type Namespace = z.infer<typeof Namespace>;

/** Códigos de erro padronizados. Nenhum erro livre circula no protocolo. */
export const ErrorCode = z.enum([
  "PROTOCOL_VERSION_MISMATCH",
  "AUTH_TOKEN_INVALID",
  "ORIGIN_REJECTED",
  "PAYLOAD_TOO_LARGE",
  "SCHEMA_VALIDATION_FAILED",
  "TIMEOUT",
  "NOT_IMPLEMENTED",
  "ADAPTER_UNAVAILABLE",
  "PAGE_NOT_RECOGNIZED",
  "ACCOUNT_UNIDENTIFIED",
  "DATA_NOT_COLLECTED",
  "CONFLICT_IN_PROGRESS",
  "GEMINI_QUOTA_WAITING",
  "IMPROVEMENT_NOT_APPROVED",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Limite de payload por namespace (bytes de JSON serializado). */
export const PAYLOAD_LIMITS: Record<Namespace, number> = {
  system: 64 * 1024,
  capture: 2 * 1024 * 1024,
  adapter: 512 * 1024,
  kpi: 512 * 1024,
  finance: 512 * 1024,
  agent: 1024 * 1024,
  gemini: 1024 * 1024,
  improvement: 1024 * 1024,
};

/** Envelope base: todo campo obrigatório, nada opcional na fronteira. */
export const Envelope = z.object({
  protocolVersion: z.string(),
  messageId: z.string().uuid(),
  correlationId: z.string().uuid(),
  type: MessageType,
  namespace: Namespace,
  timestamp: z.string().datetime(),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof Envelope>;

/** Corpo de erro — o único payload que não depende do namespace. */
export const ErrorPayload = z.object({
  code: ErrorCode,
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorPayload = z.infer<typeof ErrorPayload>;

/** Handshake: primeira mensagem de qualquer conexão. */
export const HandshakeRequest = z.object({
  token: z.string().min(16),
  clientVersion: z.string(),
  protocolVersion: z.string(),
});
export type HandshakeRequest = z.infer<typeof HandshakeRequest>;

export const HandshakeResponse = z.object({
  accepted: z.boolean(),
  serverVersion: z.string(),
  protocolVersion: z.string(),
  sessionId: z.string().uuid().optional(),
  error: ErrorPayload.optional(),
});
export type HandshakeResponse = z.infer<typeof HandshakeResponse>;

/** Helpers de construção de envelope. */
export function makeEnvelope(
  type: MessageType,
  namespace: Namespace,
  payload: unknown,
  opts?: { correlationId?: string; messageId?: string },
): Envelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: opts?.messageId ?? crypto.randomUUID(),
    correlationId: opts?.correlationId ?? crypto.randomUUID(),
    type,
    namespace,
    timestamp: new Date().toISOString(),
    payload,
  };
}

export function makeError(
  code: ErrorCode,
  message: string,
  correlationId: string,
  detail?: Record<string, unknown>,
): Envelope {
  return makeEnvelope(
    "ERROR",
    "system",
    { code, message, ...(detail ? { detail } : {}) },
    { correlationId },
  );
}

/**
 * Serializa e mede o payload antes de enviar: limite é contrato, não sugestão.
 * Usa TextEncoder (não Buffer) para funcionar igual no Node e na extensão.
 */
export function measurePayload(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload ?? null)).length;
}

export function exceedsLimit(namespace: Namespace, payload: unknown): boolean {
  return measurePayload(payload) > PAYLOAD_LIMITS[namespace];
}
