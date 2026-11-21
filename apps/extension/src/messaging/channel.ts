/**
 * Cliente do canal loopback, do lado da extensão.
 *
 * O service worker MV3 pode ser suspenso a qualquer momento, então este
 * cliente não guarda estado de negócio: guarda apenas a conexão e a fila de
 * requisições pendentes, e reconecta sozinho com backoff.
 *
 * Regra de integridade: nada é enviado sem pareamento; toda resposta é
 * correlacionada; timeout vira erro explícito, nunca "talvez tenha funcionado".
 */
import {
  HandshakeResponse,
  PROTOCOL_VERSION,
  Envelope,
  makeEnvelope,
  type Envelope as EnvelopeT,
  type Namespace,
} from "@lma/protocol";

const STORAGE_KEY = "lma.channel";
const DEFAULT_URL = "ws://127.0.0.1:47821";
const REQUEST_TIMEOUT_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type ChannelStatus =
  | { state: "disconnected"; reason?: string }
  | { state: "connecting" }
  | { state: "paired"; sessionId: string; serverVersion: string }
  | { state: "error"; code: string; message: string };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type StatusListener = (status: ChannelStatus) => void;

class Channel {
  private socket: WebSocket | null = null;
  private status: ChannelStatus = { state: "disconnected" };
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<StatusListener>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldStayConnected = false;

  getStatus(): ChannelStatus {
    return this.status;
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private setStatus(next: ChannelStatus): void {
    this.status = next;
    for (const listener of this.listeners) listener(next);
  }

  /** Conecta e pareia com o token informado pelo usuário. */
  async connect(url: string, token: string): Promise<ChannelStatus> {
    this.shouldStayConnected = true;
    this.clearReconnect();
    await chrome.storage.local.set({ [STORAGE_KEY]: { url, token } });
    return this.open(url, token);
  }

  /** Reconecta usando o pareamento salvo (após suspensão do worker). */
  async resume(): Promise<ChannelStatus> {
    const stored = await this.readStored();
    if (!stored) return this.status;
    this.shouldStayConnected = true;
    return this.open(stored.url, stored.token);
  }

  disconnect(): void {
    this.shouldStayConnected = false;
    this.clearReconnect();
    this.socket?.close(1000, "user disconnect");
    this.socket = null;
    this.setStatus({ state: "disconnected" });
  }

  private async readStored(): Promise<{ url: string; token: string } | null> {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const value = data[STORAGE_KEY] as { url?: string; token?: string } | undefined;
    if (!value?.url || !value?.token) return null;
    return { url: value.url, token: value.token };
  }

  private open(url: string, token: string): Promise<ChannelStatus> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.status);
    }
    this.setStatus({ state: "connecting" });

    return new Promise((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        const status: ChannelStatus = { state: "error", code: "INTERNAL_ERROR", message: "URL inválida" };
        this.setStatus(status);
        resolve(status);
        return;
      }
      this.socket = ws;

      const settle = (status: ChannelStatus) => {
        this.setStatus(status);
        resolve(status);
      };

      ws.addEventListener("open", () => {
        const handshake = {
          token,
          clientVersion: chrome.runtime.getManifest().version,
          protocolVersion: PROTOCOL_VERSION,
        };
        ws.send(JSON.stringify(handshake));
      });

      ws.addEventListener("message", (event) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }

        // Primeira resposta: handshake.
        const hs = HandshakeResponse.safeParse(parsed);
        if (hs.success) {
          if (hs.data.accepted && hs.data.sessionId) {
            this.reconnectAttempt = 0;
            settle({
              state: "paired",
              sessionId: hs.data.sessionId,
              serverVersion: hs.data.serverVersion,
            });
          } else {
            const code = hs.data.error?.code ?? "AUTH_TOKEN_INVALID";
            settle({ state: "error", code, message: hs.data.error?.message ?? "pareamento recusado" });
          }
          return;
        }

        // Respostas e erros correlacionados.
        const env = Envelope.safeParse(parsed);
        if (!env.success) return;
        const waiter = this.pending.get(env.data.correlationId);
        if (!waiter) return;
        this.pending.delete(env.data.correlationId);
        clearTimeout(waiter.timer);
        if (env.data.type === "ERROR") {
          const payload = env.data.payload as { code?: string; message?: string };
          waiter.reject(new Error(`${payload.code ?? "INTERNAL_ERROR"}: ${payload.message ?? ""}`));
        } else {
          waiter.resolve(env.data.payload);
        }
      });

      ws.addEventListener("close", (event) => {
        this.socket = null;
        for (const [id, waiter] of this.pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`CONNECTION_CLOSED: ${event.code}`));
          this.pending.delete(id);
        }
        if (this.shouldStayConnected && this.status.state !== "error") {
          this.setStatus({ state: "disconnected", reason: `código ${event.code}` });
          this.scheduleReconnect(url, token);
        }
      });

      ws.addEventListener("error", () => {
        // O evento de erro não traz detalhe útil; o close cuida do estado.
      });
    });
  }

  private scheduleReconnect(url: string, token: string): void {
    this.clearReconnect();
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      if (this.shouldStayConnected) void this.open(url, token);
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Envia uma requisição e espera a resposta correlacionada. */
  async request<T = unknown>(namespace: Namespace, payload: unknown): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.status.state !== "paired") {
      throw new Error("NOT_PAIRED: canal não pareado");
    }
    const env: EnvelopeT = makeEnvelope("REQUEST", namespace, payload);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(env.correlationId);
        reject(new Error("TIMEOUT: o serviço local não respondeu"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(env.correlationId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.socket?.send(JSON.stringify(env));
    });
  }
}

export const channel = new Channel();
export { DEFAULT_URL };
