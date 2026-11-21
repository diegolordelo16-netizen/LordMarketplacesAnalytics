/**
 * Side Panel — a interface de operação do Lord Marketplaces Analytics.
 *
 * Princípio da tela: cada número exibido pode ser explicado. Onde não há dado,
 * aparece o motivo (NOT_COLLECTED, UNKNOWN) — nunca um zero decorativo.
 */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MARKETPLACE_LABEL,
  PAGE_KIND_LABEL,
  type PageContext,
} from "../adapters/detect-page.js";
import "./styles.css";

// --------------------------------------------------------------- tipos do canal

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

interface MetricSummary {
  metric: string;
  latest: number | null;
  latestQuality: string | null;
  latestAt: string | null;
  changePct: number | null;
  insufficientHistory: boolean;
}

interface Listing {
  entityRef: string;
  title: string | null;
  priceCents: number | null;
  stock: number | null;
  metrics: MetricSummary[];
}

interface Alert {
  id: string;
  severity: "info" | "attention" | "critical";
  title: string;
  detail: string;
  evidence: string;
  entityRef: string | null;
}

interface ListingsReply {
  listings: Listing[];
  qualityCensus: Record<string, number>;
  alerts: Alert[];
}

interface Recommendation {
  id: string;
  priority: number;
  area: string;
  title: string;
  rationale: string;
  actions: string[];
  evidence: string[];
  confidence: "alta" | "media" | "baixa";
}

interface BrainReport {
  generatedAt: string;
  listingsAnalyzed: number;
  recommendations: Recommendation[];
  blindSpots: string[];
}

interface Improvement {
  id: string;
  title: string;
  rationale: string;
  kind: string;
  status: string;
  createdAt: string;
  decisionNote: string | null;
}

interface CaptureReply {
  runId: string;
  outcome: string;
  cardsSeen: number;
  cardsParsed: number;
  observationsWritten: number;
  note?: string;
}

async function send<T = unknown>(message: unknown): Promise<PanelReply<T>> {
  return (await chrome.runtime.sendMessage(message)) as PanelReply<T>;
}

async function request<T = unknown>(namespace: string, action: string, extra: Record<string, unknown> = {}) {
  const reply = await send<T>({ kind: "channel.request", namespace, payload: { action, ...extra } });
  if (!reply.ok) throw new Error(reply.error ?? "falha no canal");
  return reply.result as T;
}

// ----------------------------------------------------------------- formatação

function money(cents: number | null): string {
  if (cents === null) return "—";
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function stockLabel(stock: number | null): string {
  return stock === null ? "não legível" : String(stock);
}

// ---------------------------------------------------------------- componentes

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

function Card({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function QualityBadge({ quality }: { quality: string | null }) {
  const map: Record<string, string> = {
    VERIFIED: "verificado",
    ZERO: "zero",
    UNKNOWN: "ilegível",
    NOT_COLLECTED: "não coletado",
    UNAVAILABLE: "indisponível",
    ESTIMATED: "estimado",
    CALCULATED: "calculado",
  };
  return <span className={`q q-${(quality ?? "UNKNOWN").toLowerCase()}`}>{map[quality ?? "UNKNOWN"]}</span>;
}

// ---------------------------------------------------------------------- app

function App() {
  const [status, setStatus] = useState<ChannelStatus>({ state: "disconnected" });
  const [url, setUrl] = useState("ws://127.0.0.1:47821");
  const [token, setToken] = useState("");
  const [context, setContext] = useState<PageContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [listings, setListings] = useState<ListingsReply | null>(null);
  const [report, setReport] = useState<BrainReport | null>(null);
  const [improvements, setImprovements] = useState<Improvement[]>([]);
  const [capture, setCapture] = useState<CaptureReply | null>(null);
  const [lastAudit, setLastAudit] = useState<string | null>(null);

  const paired = status.state === "paired";

  useEffect(() => {
    void send<ChannelStatus>({ kind: "channel.status" }).then((r) => {
      if (r.ok && r.status) setStatus(r.status);
    });
    const listener = (message: { kind?: string; context?: PageContext }) => {
      if (message.kind === "context.changed" && message.context) setContext(message.context);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      try {
        const reply = (await chrome.tabs.sendMessage(tab.id, { kind: "context.get" })) as {
          ok?: boolean;
          context?: PageContext;
        };
        setContext(reply?.ok && reply.context ? reply.context : null);
      } catch {
        setContext(null);
      }
    })();
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await request<ListingsReply>("kpi", "kpi.listings");
      setListings(data);
      const brain = await request<BrainReport>("agent", "agent.report");
      setReport(brain);
      const imps = await request<{ items: Improvement[] }>("improvement", "improvement.list");
      setImprovements(imps.items);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (paired) void refresh();
  }, [paired, refresh]);

  async function connect() {
    setBusy(true);
    setNotice(null);
    const reply = await send<ChannelStatus>({ kind: "channel.connect", url, token });
    if (reply.status) setStatus(reply.status);
    if (!reply.ok) setNotice(reply.error ?? "falha ao conectar");
    if (reply.status?.state === "error") setNotice(`${reply.status.code}: ${reply.status.message}`);
    setBusy(false);
  }

  /** Captura: pede o HTML da aba ao content script e envia ao serviço local. */
  async function captureCurrent() {
    setBusy(true);
    setNotice(null);
    setCapture(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("nenhuma aba ativa");
      const page = (await chrome.tabs.sendMessage(tab.id, { kind: "capture.html" })) as {
        ok?: boolean;
        html?: string;
        context?: PageContext;
        error?: string;
      };
      if (!page?.ok || !page.html || !page.context) {
        throw new Error(page?.error ?? "a aba atual não é uma página de marketplace reconhecida");
      }
      const result = await request<CaptureReply>("capture", "capture.page", {
        marketplace: page.context.marketplace,
        pageKind: page.context.pageKind,
        pageUrl: page.context.url,
        html: page.html,
        accountRef: page.context.account,
      });
      setCapture(result);
      await refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runAudit() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await request<{ ok: boolean; text: string | null; message: string }>(
        "agent",
        "agent.audit",
      );
      setLastAudit(result.text ?? result.message);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, decision: "APPROVED" | "REJECTED") {
    setBusy(true);
    try {
      await request("improvement", "improvement.decide", { id, decision });
      await refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const totalPoints = listings ? Object.values(listings.qualityCensus).reduce((a, b) => a + b, 0) : 0;

  return (
    <main className="panel">
      <header className="head">
        <div>
          <h1>Lord Marketplaces Analytics</h1>
          <p className="sub">Local First · captura na sua própria sessão</p>
        </div>
        <StatusPill status={status} />
      </header>

      {!paired && (
        <Card title="Conectar ao serviço local">
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
          {status.state === "error" && (
            <p className="alert">
              {status.code}: {status.message}
            </p>
          )}
        </Card>
      )}

      <Card title="Aba atual">
        {context ? (
          <dl className="kv">
            <dt>Marketplace</dt>
            <dd>{MARKETPLACE_LABEL[context.marketplace]}</dd>
            <dt>Página</dt>
            <dd>{PAGE_KIND_LABEL[context.pageKind]}</dd>
            <dt>Conta</dt>
            <dd>{context.account ?? <span className="muted">não legível nesta página</span>}</dd>
          </dl>
        ) : (
          <p className="muted">Nenhum marketplace reconhecido nesta aba.</p>
        )}
        <button onClick={captureCurrent} disabled={busy || !paired || !context}>
          Capturar esta página
        </button>
        {capture && (
          <p className={capture.cardsParsed > 0 ? "ok" : "alert"}>
            {capture.cardsParsed > 0
              ? `${capture.cardsParsed} anúncio(s) lidos, ${capture.observationsWritten} observações gravadas.`
              : (capture.note ?? "Nenhum anúncio reconhecido.")}
          </p>
        )}
      </Card>

      {listings && listings.listings.length > 0 && (
        <Card
          title="Anúncios"
          aside={
            <span className="census">
              {totalPoints} observações · {listings.qualityCensus.VERIFIED ?? 0} verificadas
            </span>
          }
        >
          <ul className="listings">
            {listings.listings.map((l) => (
              <li key={l.entityRef}>
                <div className="l-head">
                  <strong>{l.title ?? <span className="muted">título não legível</span>}</strong>
                  <span className="mono">{l.entityRef}</span>
                </div>
                <div className="l-metrics">
                  <span>
                    <b>{money(l.priceCents)}</b>
                    <QualityBadge quality={l.metrics.find((m) => m.metric === "price_cents")?.latestQuality ?? null} />
                  </span>
                  <span>
                    estoque <b>{stockLabel(l.stock)}</b>
                    <QualityBadge quality={l.metrics.find((m) => m.metric === "stock")?.latestQuality ?? null} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {listings && listings.alerts.length > 0 && (
        <Card title={`Alertas (${listings.alerts.length})`}>
          <ul className="alerts">
            {listings.alerts.map((a) => (
              <li key={a.id} className={`sev-${a.severity}`}>
                <strong>{a.title}</strong>
                <p>{a.detail}</p>
                <small>{a.evidence}</small>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {report && (
        <Card title="Plano do cérebro" aside={<span className="census">{report.listingsAnalyzed} anúncios</span>}>
          {report.recommendations.length === 0 ? (
            <p className="muted">Nenhuma ação recomendada com os dados atuais.</p>
          ) : (
            <ol className="recs">
              {report.recommendations.map((r) => (
                <li key={r.id}>
                  <div className="rec-head">
                    <span className={`area area-${r.area}`}>{r.area}</span>
                    <strong>{r.title}</strong>
                    <span className={`conf conf-${r.confidence}`}>{r.confidence}</span>
                  </div>
                  <p>{r.rationale}</p>
                  <ul className="actions">
                    {r.actions.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                  <small>Base: {r.evidence.join("; ")}</small>
                </li>
              ))}
            </ol>
          )}
          {report.blindSpots.length > 0 && (
            <details className="blind">
              <summary>O que não dá para concluir ({report.blindSpots.length})</summary>
              <ul>
                {report.blindSpots.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="row">
            <button className="ghost" onClick={runAudit} disabled={busy}>
              Auditar com Gemini
            </button>
          </div>
          {lastAudit && <p className="audit">{lastAudit}</p>}
        </Card>
      )}

      {improvements.length > 0 && (
        <Card title="Central de Melhorias" aside={<span className="census">só o proprietário aprova</span>}>
          <ul className="imps">
            {improvements.map((i) => (
              <li key={i.id}>
                <div className="imp-head">
                  <strong>{i.title}</strong>
                  <span className={`st st-${i.status.toLowerCase()}`}>{i.status}</span>
                </div>
                <p>{i.rationale}</p>
                {i.status === "PROPOSED" && (
                  <div className="row">
                    <button onClick={() => decide(i.id, "APPROVED")} disabled={busy}>
                      Aprovar
                    </button>
                    <button className="ghost" onClick={() => decide(i.id, "REJECTED")} disabled={busy}>
                      Rejeitar
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {notice && <p className="alert">{notice}</p>}

      <footer className="foot">
        <p>
          Nenhuma senha, cookie ou token de marketplace é lido ou enviado. Tudo o que aparece aqui vem
          do que a página já mostra, com origem e data registradas.
        </p>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
