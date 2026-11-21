/**
 * Serviço local — canal loopback com pareamento por token.
 *
 * Regras que este arquivo implementa, e que são testáveis:
 *  - escuta APENAS em 127.0.0.1 (nunca em 0.0.0.0);
 *  - handshake obrigatório antes de qualquer mensagem de negócio;
 *  - Origin validado contra allowlist explícita (chrome-extension://<id>);
 *  - token de pareamento de uso único, com expiração, comparado em tempo constante;
 *  - payload acima do limite do namespace é recusado;
 *  - protocolVersion incompatível recusa a sessão;
 *  - eventos suspeitos vão para auditoria, não só para log de aplicação.
 */
import { WebSocketServer, type WebSocket } from "ws";
import {
  Envelope,
  HandshakeRequest,
  HandshakeResponse,
  PROTOCOL_VERSION,
  exceedsLimit,
  makeEnvelope,
  makeError,
  type Envelope as EnvelopeT,
  type ErrorCode,
  type Namespace,
} from "@lma/protocol";

export const DEFAULT_PORT = 47821;
export const DEFAULT_HOST = "127.0.0.1";

export interface AuditEvent {
  at: string;
  kind: "connection" | "handshake" | "message" | "security" | "error";
  detail: Record<string, unknown>;
}

export interface PairingToken {
  value: string;
  expiresAt: number;
  used: boolean;
}

export interface LocalAgentOptions {
  port?: number;
  host?: string;
  /** Origens aceitas, ex.: ["chrome-extension://abcdef..."] */
  allowedOrigins: string[];
  /** Token inicial; o serviço gera um novo a cada arranque se não receber. */
  tokenTtlMs?: number;
  now?: () => number;
  onAudit?: (event: AuditEvent) => void;
}

type Handler = (envelope: EnvelopeT, socket: WebSocket) => unknown;

interface Session {
  socket: WebSocket;
  origin: string;
  sessionId: string;
  pairedAt: number;
  lastSeen: number;
}

export class LocalAgentServer {
  private wss: WebSocketServer | null = null;
  private readonly sessions = new Map<WebSocket, Session>();
  private readonly handlers = new Map<string, Handler>();
  private readonly audit: AuditEvent[] = [];
  private token: PairingToken;
  private readonly opts: Required<Omit<LocalAgentOptions, "onAudit">> & {
    onAudit?: (e: AuditEvent) => void;
  };

  constructor(options: LocalAgentOptions) {
    this.opts = {
      port: options.port ?? DEFAULT_PORT,
      host: options.host ?? DEFAULT_HOST,
      allowedOrigins: options.allowedOrigins,
      tokenTtlMs: options.tokenTtlMs ?? 10 * 60 * 1000,
      now: options.now ?? Date.now,
      onAudit: options.onAudit,
    };
    this.token = this.newToken();
  }

  /** Token de pareamento vigente (exibido no painel local para o usuário). */
  get pairingToken(): string {
    return this.token.value;
  }

  get auditTrail(): readonly AuditEvent[] {
    return this.audit;
  }

  get openSessions(): number {
    return this.sessions.size;
  }

  /** Registra um handler por "namespace.acao" (ex.: "system.ping"). */
  handle(key: string, handler: Handler): void {
    this.handlers.set(key, handler);
  }

  /** Gera novo token; o anterior deixa de valer imediatamente. */
  rotateToken(): string {
    this.token = this.newToken();
    this.record("security", { kind: "token_rotated" });
    return this.token.value;
  }

  async start(): Promise<{ port: number; host: string }> {
    if (this.wss) throw new Error("servidor já iniciado");
    const wss = new WebSocketServer({
      host: this.opts.host,
      port: this.opts.port,
    });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", () => resolve());
      wss.once("error", reject);
    });
    this.wss = wss;
    wss.on("connection", (socket, req) => this.onConnection(socket, req.headers.origin));
    const address = wss.address();
    const port = typeof address === "object" && address ? address.port : this.opts.port;
    this.record("connection", { kind: "server_started", port });
    return { port, host: this.opts.host };
  }

  async stop(): Promise<void> {
    for (const socket of this.sessions.keys()) socket.close(1001, "server shutdown");
    this.sessions.clear();
    const wss = this.wss;
    this.wss = null;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  // ---------------------------------------------------------------- internos

  private newToken(): PairingToken {
    return {
      value: crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, ""),
      expiresAt: this.opts.now() + this.opts.tokenTtlMs,
      used: false,
    };
  }

  private record(kind: AuditEvent["kind"], detail: Record<string, unknown>): void {
    const event: AuditEvent = { at: new Date(this.opts.now()).toISOString(), kind, detail };
    this.audit.push(event);
    this.opts.onAudit?.(event);
  }

  private reject(socket: WebSocket, code: ErrorCode, message: string, correlationId: string) {
    socket.send(JSON.stringify(makeError(code, message, correlationId)));
    socket.close(1008, code);
  }

  private onConnection(socket: WebSocket, origin: string | undefined): void {
    // 1. Origin: allowlist explícita. Sem wildcard, nunca.
    if (!origin || !this.opts.allowedOrigins.includes(origin)) {
      this.record("security", { kind: "origin_rejected", origin: origin ?? null });
      this.reject(socket, "ORIGIN_REJECTED", "origem não autorizada", crypto.randomUUID());
      return;
    }

    let paired = false;

    socket.on("message", (raw) => {
      const text = raw.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.record("security", { kind: "malformed_json", origin });
        this.reject(socket, "SCHEMA_VALIDATION_FAILED", "JSON inválido", crypto.randomUUID());
        return;
      }

      // 2. Handshake obrigatório antes de qualquer mensagem de negócio.
      if (!paired) {
        const hs = HandshakeRequest.safeParse(parsed);
        if (!hs.success) {
          this.record("security", { kind: "handshake_invalid", origin });
          this.reject(socket, "SCHEMA_VALIDATION_FAILED", "handshake inválido", crypto.randomUUID());
          return;
        }
        if (hs.data.protocolVersion !== PROTOCOL_VERSION) {
          this.record("security", { kind: "protocol_mismatch", got: hs.data.protocolVersion });
          const resp: HandshakeResponse = {
            accepted: false,
            serverVersion: "0.1.0",
            protocolVersion: PROTOCOL_VERSION,
            error: { code: "PROTOCOL_VERSION_MISMATCH", message: "versão de protocolo incompatível" },
          };
          socket.send(JSON.stringify(resp));
          socket.close(1008, "protocol mismatch");
          return;
        }
        const valid = this.consumeToken(hs.data.token);
        if (!valid) {
          this.record("security", { kind: "token_invalid", origin });
          const resp: HandshakeResponse = {
            accepted: false,
            serverVersion: "0.1.0",
            protocolVersion: PROTOCOL_VERSION,
            error: { code: "AUTH_TOKEN_INVALID", message: "token de pareamento inválido ou expirado" },
          };
          socket.send(JSON.stringify(resp));
          socket.close(1008, "token invalid");
          return;
        }
        paired = true;
        const sessionId = crypto.randomUUID();
        this.sessions.set(socket, {
          socket,
          origin,
          sessionId,
          pairedAt: this.opts.now(),
          lastSeen: this.opts.now(),
        });
        const resp: HandshakeResponse = {
          accepted: true,
          serverVersion: "0.1.0",
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
        };
        socket.send(JSON.stringify(resp));
        this.record("handshake", { kind: "paired", origin, sessionId });
        return;
      }

      // 3. Mensagem de negócio: envelope validado campo a campo.
      const env = Envelope.safeParse(parsed);
      if (!env.success) {
        this.record("security", { kind: "envelope_invalid", issues: env.error.issues.length });
        this.reject(socket, "SCHEMA_VALIDATION_FAILED", "envelope inválido", crypto.randomUUID());
        return;
      }
      const session = this.sessions.get(socket);
      if (session) session.lastSeen = this.opts.now();

      // 4. Limite de payload é contrato, não sugestão.
      if (exceedsLimit(env.data.namespace, env.data.payload)) {
        this.record("security", {
          kind: "payload_too_large",
          namespace: env.data.namespace,
          messageId: env.data.messageId,
        });
        socket.send(
          JSON.stringify(
            makeError("PAYLOAD_TOO_LARGE", "payload acima do limite do namespace", env.data.correlationId),
          ),
        );
        return;
      }

      const action = (env.data.payload as { action?: string } | null)?.action;
      // Aceita a ação qualificada ("system.ping") ou o nome curto ("ping").
      const short = action?.includes(".") ? action.slice(action.indexOf(".") + 1) : action;
      const key = `${env.data.namespace}.${short ?? ""}`;
      const handler = this.handlers.get(key);

      if (!handler) {
        this.record("message", { kind: "not_implemented", key, messageId: env.data.messageId });
        socket.send(
          JSON.stringify(
            makeError("NOT_IMPLEMENTED", `ação não implementada: ${key}`, env.data.correlationId),
          ),
        );
        return;
      }

      try {
        const result = handler(env.data, socket);
        socket.send(
          JSON.stringify(
            makeEnvelope("RESPONSE", env.data.namespace as Namespace, result, {
              correlationId: env.data.correlationId,
            }),
          ),
        );
        this.record("message", { kind: "handled", key, messageId: env.data.messageId });
      } catch (err) {
        this.record("error", { kind: "handler_failed", key, error: String(err) });
        socket.send(
          JSON.stringify(
            makeError("INTERNAL_ERROR", "falha ao processar mensagem", env.data.correlationId),
          ),
        );
      }
    });

    socket.on("close", () => {
      const session = this.sessions.get(socket);
      if (session) this.record("connection", { kind: "closed", sessionId: session.sessionId });
      this.sessions.delete(socket);
    });

    socket.on("error", () => {
      this.sessions.delete(socket);
    });
  }

  /** Token de uso único com expiração; comparação em tempo constante. */
  private consumeToken(candidate: string): boolean {
    const now = this.opts.now();
    if (this.token.used || now > this.token.expiresAt) {
      this.record("security", { kind: "token_expired_or_used" });
      return false;
    }
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token.value);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
    if (diff !== 0) return false;
    this.token.used = true;
    return true;
  }
}
