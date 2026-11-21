/**
 * Side Panel — a interface de operação da POC.
 *
 * Mostra, com honestidade: estado do canal, contexto da aba reconhecido,
 * resultado do ping ao serviço local e a auditoria recente. Onde não há dado,
 * aparece o motivo — nunca um valor inventado.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MARKETPLACE_LABEL,
  PAGE_KIND_LABEL,
  type PageContext,
} from "../adapters/detect-page.js";
import "./styles.css";

type ChannelStatus =
  | { state: "disconnected"; reason?: string }
  | { state: "connecting" }
  | { state: "paired"; sessionId: string; serverVersion: string }
  | { state: "error"; code: string; message: string };

interface PanelReply<T = unknown> {
  ok: boolean;
  status?: ChannelStatus;
  result?: T;
  error?: string;
}

async function send<T = unknown>(message: unknown): Promise<PanelReply<T>> {
  return (await chrome.runtime.sendMessage(message)) as PanelReply<T>;
}

function StatusPill({ status }: { status: ChannelStatus }) {
  const label =
    status.state === "paired"
      ? "Pareado"
      : status.state === "connecting"
        ? "Conectando"
        : status.state === "error"
          ? "Erro"
          : "Desconectado";
  return <span className={`pill pill-${status.state}`}>{label}</span>;
}

function App() {
  const [status, setStatus] = useState<ChannelStatus>({ state: "disconnected" });
  const [url, setUrl] = useState("ws://127.0.0.1:47821");
  const [token, setToken] = useState("");
  const [context, setContext] = useState<PageContext | null>(null);
  const [ping, setPing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Estado do canal: consulta e escuta.
  useEffect(() => {
    void send<ChannelStatus>({ kind: "channel.status" }).then((r) => {
      if (r.ok && r.status) setStatus(r.status);
    });
    const listener = (message: { kind?: string; context?: PageContext; status?: ChannelStatus }) => {
      if (message.kind === "context.changed" && message.context) setContext(message.context);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // Contexto da aba ativa.
  useEffect(() => {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      try {
        const reply = (await chrome.tabs.sendMessage(tab.id, { kind: "context.get" })) as {
          ok?: boolean;
          context?: PageContext;
        };
        if (reply?.ok && reply.context) setContext(reply.context);
        else setContext(null);
      } catch {
        setContext(null); // aba sem content script: nenhum marketplace aberto
      }
    })();
  }, []);

  async function connect() {
    setBusy(true);
    setNotice(null);
    const reply = await send<ChannelStatus>({ kind: "channel.connect", url, token });
    if (reply.status) setStatus(reply.status);
    if (!reply.ok) setNotice(reply.error ?? "falha ao conectar");
    if (reply.status?.state === "error") setNotice(`${reply.status.code}: ${reply.status.message}`);
    setBusy(false);
  }

  async function testPing() {
    setBusy(true);
    setNotice(null);
    try {
      const reply = await send<{ pong: boolean; serverVersion: string }>({
        kind: "channel.request",
        namespace: "system",
        payload: { action: "system.ping" },
      });
      if (reply.ok && reply.result) {
        setPing(`pong do serviço local v${reply.result.serverVersion} — ${new Date().toLocaleTimeString("pt-BR")}`);
      } else {
        setPing(null);
        setNotice(reply.error ?? "sem resposta");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="panel">
      <header className="head">
        <div>
          <h1>Lord Marketplaces Analytics</h1>
          <p className="sub">Prova de conceito · captura na sessão autenticada</p>
        </div>
        <StatusPill status={status} />
      </header>

      <section className="card">
        <h2>Canal com o serviço local</h2>
        {status.state === "paired" ? (
          <>
            <dl className="kv">
              <dt>Sessão</dt>
              <dd className="mono">{status.sessionId.slice(0, 8)}…</dd>
              <dt>Servidor</dt>
              <dd>v{status.serverVersion}</dd>
            </dl>
            <div className="row">
              <button onClick={testPing} disabled={busy}>
                Testar ping
              </button>
              <button className="ghost" onClick={() => void send({ kind: "channel.disconnect" }).then((r) => r.status && setStatus(r.status))}>
                Desconectar
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="field">
              <span>Endereço do canal</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
            </label>
            <label className="field">
              <span>Token de pareamento</span>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="cole o token mostrado pelo serviço local"
                spellCheck={false}
              />
            </label>
            <button onClick={connect} disabled={busy || token.length < 16}>
              Parear
            </button>
          </>
        )}
        {status.state === "error" && (
          <p className="alert">
            {status.code}: {status.message}
          </p>
        )}
        {ping && <p className="ok">{ping}</p>}
        {notice && <p className="alert">{notice}</p>}
      </section>

      <section className="card">
        <h2>Aba atual</h2>
        {context ? (
          <dl className="kv">
            <dt>Marketplace</dt>
            <dd>{MARKETPLACE_LABEL[context.marketplace]}</dd>
            <dt>Página</dt>
            <dd>{PAGE_KIND_LABEL[context.pageKind]}</dd>
            <dt>Conta</dt>
            <dd>
              {context.account ?? <span className="muted">não legível nesta página</span>}
            </dd>
            <dt>Confiança</dt>
            <dd>{context.confidence}</dd>
            <dt>Detectado</dt>
            <dd>{new Date(context.detectedAt).toLocaleTimeString("pt-BR")}</dd>
          </dl>
        ) : (
          <p className="muted">
            Nenhum marketplace reconhecido nesta aba. Abra o Mercado Livre ou a Shopee e entre na sua
            conta.
          </p>
        )}
      </section>

      <footer className="foot">
        <p>
          Nenhuma senha, cookie ou token de marketplace é lido ou enviado. Os dados exibidos vêm do
          que a página já mostra.
        </p>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
