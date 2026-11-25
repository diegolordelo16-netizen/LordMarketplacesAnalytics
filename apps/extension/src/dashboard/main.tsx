/**
 * Dashboard do Lord Marketplaces Analytics.
 *
 * É a tela principal do produto: tudo o que o software faz fica visível e
 * organizado em um só lugar, com a origem de cada número ao lado.
 *
 * Duas regras de produto que a interface não pode quebrar:
 *  1. Nada de zero decorativo. Campo não lido aparece como "não coletado".
 *  2. API é acréscimo, não requisito: a captura pela sessão do navegador
 *     funciona com a credencial vazia, e a tela diz isso.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MARKETPLACE_LABEL, PAGE_KIND_LABEL, type PageContext } from "../adapters/detect-page.js";
import {
  ask,
  channelStatus,
  connectChannel,
  readStored,
  saveStored,
  currentContext,
  grabHtml,
  type ApiCatalog,
  type BrainReport,
  type CaptureReply,
  type ChannelStatus,
  type ConnectorSpec,
  type CredentialRow,
  type HealthReply,
  type ImprovementRow,
  type ListingsReply,
  type SalesStock,
  type OverviewReply,
} from "./data.js";
import "./theme.css";
import { AreaChart, BarChart, Donut, type Point } from "./charts.js";
import { CompetitorsPage, DescriptionPage, FinancePage, KpiCard, MissionsPage, type CompetitorView, type MissionView } from "./pages.js";

// ------------------------------------------------------------ formatação

const brl = (cents: number | null | undefined) =>
  cents === null || cents === undefined
    ? "—"
    : (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
};

const QUALITY_LABEL: Record<string, string> = {
  VERIFIED: "verificado",
  ZERO: "zero",
  UNKNOWN: "ilegível",
  NOT_COLLECTED: "não coletado",
  UNAVAILABLE: "indisponível",
  ESTIMATED: "estimado",
  CALCULATED: "calculado",
};

function Quality({ quality }: { quality: string | null | undefined }) {
  const q = quality ?? "UNKNOWN";
  return <span className={`q q-${q.toLowerCase()}`}>{QUALITY_LABEL[q] ?? q}</span>;
}

// ------------------------------------------------------------ componentes base

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function Panel({
  title,
  hint,
  aside,
  children,
  className,
}: {
  title: string;
  hint?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className ?? ""}`}>
      <header className="panel-head">
        <div>
          <h2>{title}</h2>
          {hint && <p className="hint">{hint}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}

// ------------------------------------------------------------ navegação

type Tab =
  | "visao"
  | "missoes"
  | "concorrentes"
  | "descricao"
  | "financeiro"
  | "captura"
  | "anuncios"
  | "pedidos"
  | "cerebro"
  | "melhorias"
  | "api"
  | "sistema";

const GROUP_LABEL: Record<string, string> = {
  operação: "Operação",
  inteligência: "Inteligência",
  dados: "Dados",
  governança: "Governança",
};

const TABS: { id: Tab; label: string; icon: string; group: string }[] = [
  { id: "visao", label: "Visão geral", icon: "◧", group: "operação" },
  { id: "missoes", label: "Missões do dia", icon: "✦", group: "operação" },
  { id: "concorrentes", label: "Concorrentes", icon: "◎", group: "inteligência" },
  { id: "descricao", label: "Descrição & CRO", icon: "✎", group: "inteligência" },
  { id: "financeiro", label: "Margem & preço", icon: "◈", group: "inteligência" },
  { id: "captura", label: "Captura", icon: "⇩", group: "dados" },
  { id: "anuncios", label: "Anúncios", icon: "▤", group: "dados" },
  { id: "pedidos", label: "Pedidos & vendas", icon: "▦", group: "dados" },
  { id: "cerebro", label: "Plano do cérebro", icon: "✱", group: "governança" },
  { id: "melhorias", label: "Central de melhorias", icon: "⚙", group: "governança" },
  { id: "api", label: "APIs dos marketplaces", icon: "⇄", group: "governança" },
  { id: "sistema", label: "Sistema", icon: "ⓘ", group: "governança" },
];

// ------------------------------------------------------------ app

export function Dashboard() {
  const [tab, setTab] = useState<Tab>("visao");
  const [status, setStatus] = useState<ChannelStatus>({ state: "disconnected" });
  const [url, setUrl] = useState("ws://127.0.0.1:47821");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [context, setContext] = useState<PageContext | null>(null);
  const [listings, setListings] = useState<ListingsReply | null>(null);
  const [report, setReport] = useState<BrainReport | null>(null);
  const [improvements, setImprovements] = useState<ImprovementRow[]>([]);
  const [sales, setSales] = useState<SalesStock | null>(null);
  const [health, setHealth] = useState<HealthReply | null>(null);
  const [capture, setCapture] = useState<CaptureReply | null>(null);
  const [catalog, setCatalog] = useState<ApiCatalog | null>(null);
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [auditText, setAuditText] = useState<string | null>(null);
  const [recordings, setRecordings] = useState(0);
  const [overview, setOverview] = useState<OverviewReply | null>(null);
  const [missions, setMissions] = useState<MissionView[]>([]);
  const [competitors, setCompetitors] = useState<CompetitorView[]>([]);
  const [, setReloadKey] = useState(0);

  const paired = status.state === "paired";

  // ---- estado inicial
  useEffect(() => {
    void channelStatus().then((s) => {
      if (s) setStatus(s);
    });
    void currentContext().then(setContext);
    // Se a extensão foi instalada, o token vem do arquivo do instalador via
    // armazenamento local preenchido no primeiro pareamento.
    void readStored().then((v) => {
      if (typeof v.lmaToken === "string") setToken(v.lmaToken);
      if (typeof v.lmaUrl === "string") setUrl(v.lmaUrl);
      if (typeof v.lmaRecordings === "number") setRecordings(v.lmaRecordings);
    });
  }, []);

  // ---- dados: só busca o que faz sentido buscar
  const refresh = useCallback(async () => {
    setNotice(null);
    try {
      const [l, b, i, s, h, o, m, c] = await Promise.all([
        ask<ListingsReply>("kpi", "kpi.listings"),
        ask<BrainReport>("agent", "agent.report"),
        ask<{ items: ImprovementRow[] }>("improvement", "improvement.list"),
        ask<SalesStock>("kpi", "kpi.salesStock"),
        ask<HealthReply>("system", "system.health"),
        ask<OverviewReply>("kpi", "kpi.overview"),
        ask<{ missions: MissionView[] }>("missions", "missions.today"),
        ask<{ competitors: CompetitorView[] }>("competitor", "competitor.list"),
      ]);
      setListings(l);
      setReport(b);
      setImprovements(i.items);
      setSales(s);
      setHealth(h);
      setOverview(o);
      setMissions(m.missions);
      setCompetitors(c.competitors);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!paired) return;
    void refresh();
    void (async () => {
      try {
        const [c, cr] = await Promise.all([
          ask<ApiCatalog>("api", "api.catalog"),
          ask<{ credentials: CredentialRow[] }>("api", "api.list"),
        ]);
        setCatalog(c);
        setCredentials(cr.credentials);
      } catch {
        /* painel de API é opcional: falha aqui não derruba o resto */
      }
    })();
  }, [paired, refresh]);

  async function connect() {
    setBusy(true);
    setNotice(null);
    try {
      const reply = await connectChannel(url, token);
      if (reply.status) setStatus(reply.status);
      if (!reply.ok) setNotice(reply.error ?? "falha ao conectar");
      if (reply.status?.state === "paired") {
        await saveStored({ lmaToken: token, lmaUrl: url });
      }
    } finally {
      setBusy(false);
    }
  }

  async function captureCurrentPage() {
    setBusy(true);
    setNotice(null);
    setCapture(null);
    try {
      const got = await grabHtml();
      if ("error" in got) throw new Error(got.error);
      const isOrders = got.context.pageKind === "orders";
      const result = await ask<CaptureReply>(
        "capture",
        isOrders ? "capture.orders" : "capture.page",
        isOrders
          ? { marketplace: got.context.marketplace, pageUrl: got.context.url, html: got.html, accountRef: got.context.account }
          : {
              marketplace: got.context.marketplace,
              pageKind: got.context.pageKind,
              pageUrl: got.context.url,
              html: got.html,
              accountRef: got.context.account,
            },
      );
      setCapture(result);
      const n = recordings + 1;
      setRecordings(n);
      void saveStored({ lmaRecordings: n });
      await refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, decision: "APPROVED" | "REJECTED") {
    setBusy(true);
    try {
      await ask("improvement", "improvement.decide", { id, decision });
      await refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function audit() {
    setBusy(true);
    try {
      const r = await ask<{ ok: boolean; text: string | null; message: string }>("agent", "agent.audit");
      setAuditText(r.text ?? r.message);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function reloadApi() {
    try {
      const [c, cr] = await Promise.all([
        ask<ApiCatalog>("api", "api.catalog"),
        ask<{ credentials: CredentialRow[] }>("api", "api.list"),
      ]);
      setCatalog(c);
      setCredentials(cr.credentials);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function generateMissions() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await ask<{ missions: MissionView[] }>("missions", "missions.generate");
      setMissions(r.missions);
      setNotice(r.missions.length === 0 ? "Nenhum gargalo com dado suficiente para virar missão hoje." : `${r.missions.length} missão(ões) geradas a partir dos dados coletados.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function decideMission(id: string, status: "DONE" | "DISMISSED") {
    setBusy(true);
    try {
      await ask("missions", "missions.decide", { id, status });
      setMissions(missions.map((m) => (m.id === id ? { ...m, status } : m)));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const census = listings?.qualityCensus ?? {};
  const totalPoints = Object.values(census).reduce((a, b) => a + b, 0);
  const verified = census.VERIFIED ?? 0;
  const coverage = totalPoints > 0 ? Math.round((verified / totalPoints) * 100) : 0;
  const critical = listings?.alerts.filter((a) => a.severity === "critical").length ?? 0;
  const attention = listings?.alerts.filter((a) => a.severity === "attention").length ?? 0;

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <div className="logo">L</div>
          <div>
            <strong>Lord</strong>
            <span>Marketplaces Analytics</span>
          </div>
        </div>

        <nav>
          {TABS.map((t, i) => (
            <Fragment key={t.id}>
              {i === 0 || TABS[i - 1].group !== t.group ? (
                <span className="group-label">{GROUP_LABEL[t.group]}</span>
              ) : null}
              <button
                className={`nav ${tab === t.id ? "on" : ""}`}
                onClick={() => setTab(t.id)}
                type="button"
              >
                <span className="nav-icon">{t.icon}</span>
                {t.label}
                {t.id === "melhorias" && improvements.some((i) => i.status === "PROPOSED") && <span className="dot" />}
              </button>
            </Fragment>
          ))}
        </nav>

        <div className="rail-foot">
          <div className={`conn ${status.state}`}>
            <span className="led" />
            {status.state === "paired" ? "Serviço pareado" : status.state === "connecting" ? "Conectando" : "Desconectado"}
          </div>
          <p className="tiny">
            Local First · nada sai deste computador
            <br />
            v{health?.version ?? "—"}
          </p>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>{TABS.find((t) => t.id === tab)?.label}</h1>
            <p className="sub">
              {context ? (
                <>
                  {MARKETPLACE_LABEL[context.marketplace]} · {PAGE_KIND_LABEL[context.pageKind]}
                  {context.account ? ` · ${context.account}` : " · conta não legível"}
                </>
              ) : (
                "Nenhum marketplace reconhecido na aba ativa"
              )}
            </p>
          </div>
          <div className="top-actions">
            <button className="btn ghost" onClick={() => setTab("visao")} type="button" title="Voltar ao dashboard principal">
              ⌂ Abrir painel
            </button>
            <button className="btn ghost" onClick={() => void refresh()} disabled={!paired || busy} type="button">
              Atualizar dados
            </button>
            <button className="btn" onClick={() => void captureCurrentPage()} disabled={!paired || busy || !context} type="button">
              {busy ? "Capturando…" : "Capturar esta página"}
            </button>
          </div>
        </header>

        {!paired && (
          <Panel
            title="Conectar ao serviço local"
            hint="O serviço roda na sua máquina (127.0.0.1) e imprime o token ao abrir. Ele também aparece em http://127.0.0.1:47822/"
          >
            <div className="grid2">
              <label className="field">
                <span>Endereço do canal</span>
                <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
              </label>
              <label className="field">
                <span>Token de pareamento</span>
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="cole o token do serviço local"
                  spellCheck={false}
                />
              </label>
            </div>
            <button className="btn" onClick={connect} disabled={busy || token.length < 16} type="button">
              Parear
            </button>
            {status.state === "error" && <p className="alert">{status.code}: {status.message}</p>}
          </Panel>
        )}

        {notice && <p className="alert">{notice}</p>}

        {paired && tab === "visao" && (
          <Overview
            listings={listings}
            sales={sales}
            report={report}
            health={health}
            overview={overview}
            missions={missions}
            competitors={competitors}
            coverage={coverage}
            verified={verified}
            totalPoints={totalPoints}
            critical={critical}
            attention={attention}
            recordings={recordings}
            credentials={credentials}
            goTo={setTab}
            onGenerateMissions={() => void generateMissions()}
          />
        )}

        {paired && tab === "missoes" && (
          <MissionsPage missions={missions} busy={busy} onGenerate={() => void generateMissions()} onDecide={(id, s) => void decideMission(id, s)} />
        )}

        {paired && tab === "concorrentes" && (
          <CompetitorsPage
            listings={listings?.listings.map((l) => ({ entityRef: l.entityRef, title: l.title })) ?? []}
            busy={busy}
            setBusy={setBusy}
            setNotice={setNotice}
            onChanged={() => setReloadKey((k) => k + 1)}
          />
        )}

        {paired && tab === "descricao" && (
          <DescriptionPage
            listings={listings?.listings.map((l) => ({ entityRef: l.entityRef, title: l.title, priceCents: l.priceCents })) ?? []}
            busy={busy}
            setBusy={setBusy}
            setNotice={setNotice}
          />
        )}

        {paired && tab === "financeiro" && (
          <FinancePage
            listings={listings?.listings.map((l) => ({ entityRef: l.entityRef, title: l.title, priceCents: l.priceCents })) ?? []}
            busy={busy}
            setBusy={setBusy}
            setNotice={setNotice}
          />
        )}

        {paired && tab === "captura" && (
          <>
            <Panel
              title="Captura pela sessão do navegador"
              hint="O jeito principal: você abre o painel do vendedor no Chrome e o produto lê o que a página já mostra. Sem senha, sem cookie, sem API."
              aside={<Badge tone="ok">não precisa de API</Badge>}
            >
              <ol className="steps">
                <li>Abra a lista de anúncios, de produtos ou de pedidos no painel do vendedor.</li>
                <li>Volte para esta aba e clique em <strong>Capturar esta página</strong>.</li>
                <li>O dado entra no banco local com origem, data e método registrados.</li>
              </ol>
              <div className="capture-box">
                <div>
                  <span className="label">Aba ativa</span>
                  <strong>{context ? `${MARKETPLACE_LABEL[context.marketplace]} — ${PAGE_KIND_LABEL[context.pageKind]}` : "não reconhecida"}</strong>
                </div>
                <button className="btn" onClick={() => void captureCurrentPage()} disabled={busy || !context} type="button">
                  {busy ? "Capturando…" : "Capturar esta página"}
                </button>
              </div>
              {capture && (
                <div className={`result ${(capture.cardsParsed ?? capture.rowsParsed ?? 0) > 0 ? "good" : "warn"}`}>
                  <strong>
                    {(capture.cardsParsed ?? 0) > 0 || (capture.rowsParsed ?? 0) > 0
                      ? `${capture.cardsParsed ?? capture.rowsParsed} item(ns) lidos · ${capture.observationsWritten} observações gravadas`
                      : (capture.note ?? "Nenhum item reconhecido nesta página")}
                  </strong>
                  <span className="mono">
                    {capture.cardsSeen !== undefined && `vistos ${capture.cardsSeen} · `}
                    {capture.rowsWithoutId ? `sem id ${capture.rowsWithoutId} · ` : ""}
                    {capture.outcome}
                  </span>
                </div>
              )}
            </Panel>

            <Panel title="O que cada captura registra" hint="Proveniência completa: nada entra sem origem">
              <div className="grid4">
                {[
                  ["Mercado Livre", "Anúncios: título, preço, estoque", "listing"],
                  ["Shopee", "Produtos: título, preço, estoque", "product"],
                  ["Pedidos (ambos)", "Valor, data, status", "order"],
                  ["Recaptura", "Nova observação — nunca sobrescreve", "append-only"],
                ].map(([t, d, tag]) => (
                  <div className="mini" key={t}>
                    <strong>{t}</strong>
                    <span>{d}</span>
                    <Badge tone="soft">{tag}</Badge>
                  </div>
                ))}
              </div>
            </Panel>
          </>
        )}

        {paired && tab === "anuncios" && <Listings listings={listings} coverage={coverage} verified={verified} totalPoints={totalPoints} />}

        {paired && tab === "pedidos" && <Orders sales={sales} listings={listings} />}

        {paired && tab === "cerebro" && (
          <Plan report={report} auditText={auditText} onAudit={audit} busy={busy} geminiConfigured={health?.gemini.configured ?? false} />
        )}

        {paired && tab === "melhorias" && (
          <Improvements items={improvements} onDecide={decide} busy={busy} />
        )}

        {paired && tab === "api" && (
          <ApiPage
            catalog={catalog}
            credentials={credentials}
            onReload={reloadApi}
            setNotice={setNotice}
            busy={busy}
          />
        )}

        {paired && tab === "sistema" && <System health={health} capture={capture} onRefresh={refresh} />}
      </main>
    </div>
  );
}

// ------------------------------------------------------------ visão geral

function Overview(props: {
  listings: ListingsReply | null;
  sales: SalesStock | null;
  report: BrainReport | null;
  health: HealthReply | null;
  overview: OverviewReply | null;
  missions: MissionView[];
  competitors: CompetitorView[];
  coverage: number;
  verified: number;
  totalPoints: number;
  critical: number;
  attention: number;
  recordings: number;
  credentials: CredentialRow[];
  goTo: (t: Tab) => void;
  onGenerateMissions: () => void;
}) {
  const {
    listings, sales, report, health, overview, missions, competitors,
    coverage, verified, totalPoints, critical, attention, recordings, credentials, goTo, onGenerateMissions,
  } = props;
  const announcements = listings?.listings ?? [];
  const priced = announcements.filter((a) => a.priceCents !== null).length;

  // Filtro de período: recorta a série, não inventa dado que não existe.
  const [range, setRange] = useState<7 | 30 | 90>(30);
  const [market, setMarket] = useState<string>("todos");
  const [query, setQuery] = useState("");

  const markets = Object.keys(overview?.marketplaces ?? {});
  const revenue: Point[] = (overview?.revenueSeries ?? [])
    .slice(-range)
    .map((d) => ({ label: dayLabel(d.day), value: d.cents }));
  const revenueTotal = revenue.reduce((a, p) => a + (p.value ?? 0), 0);

  const filtered = announcements.filter((a) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (a.title ?? "").toLowerCase().includes(q) || a.entityRef.toLowerCase().includes(q);
  });

  const byListing = filtered.slice(0, 8).map((a) => {
    const sold = a.metrics.find((m) => m.metric === "sold")?.latest ?? null;
    return { label: a.title ?? a.entityRef, value: sold };
  });

  const qualityParts = Object.entries(overview?.quality ?? {}).map(([k, v]) => ({
    label: QUALITY_LABEL[k] ?? k,
    value: v,
    tone: k === "VERIFIED" ? "teal" : k === "ZERO" ? "sky" : k === "ESTIMATED" ? "amber" : "rose",
  }));

  return (
    <>
      <div className="kpis">
        <KpiCard label="Anúncios monitorados" value={String(overview?.totals.listings ?? announcements.length)} foot={`${priced} com preço legível`} tone="violet" />
        <KpiCard label="Vendas capturadas" value={brl(sales?.totalCents ?? 0)} foot={`${sales?.ordersWithValue ?? 0} pedido(s) com valor`} tone="teal" />
        <KpiCard
          label="Margem média"
          value={overview?.totals.marginAvgBp === null || overview?.totals.marginAvgBp === undefined ? "sem custo" : `${(overview.totals.marginAvgBp / 100).toFixed(1)}%`}
          foot={`${overview?.totals.marginKnown ?? 0} anúncio(s) com custo cadastrado`}
          tone={overview?.totals.marginAvgBp !== null && (overview?.totals.marginAvgBp ?? 0) < 1500 ? "amber" : "teal"}
        />
        <KpiCard label="Qualidade dos dados" value={`${coverage}%`} foot={`${verified} de ${totalPoints} verificados`} tone={coverage < 30 ? "amber" : "teal"} />
        <KpiCard label="Concorrentes" value={String(overview?.totals.competitors ?? competitors.length)} foot="em monitoramento" tone="sky" />
        <KpiCard label="Alertas" value={String(critical + attention)} foot={`${critical} crítico(s) · ${attention} atenção`} tone={critical > 0 ? "rose" : "violet"} />
      </div>

      <section className="card">
        <header className="card-head">
          <div>
            <h2>Evolução do faturamento</h2>
            <p>{brl(revenueTotal)} no período selecionado · só dias com coleta entram na linha</p>
          </div>
          <div className="row">
            <select value={market} onChange={(e) => setMarket(e.target.value)} style={{ width: 160 }}>
              <option value="todos">Todos os marketplaces</option>
              {markets.map((m) => (
                <option key={m} value={m}>{MARKETPLACE_LABEL[m as keyof typeof MARKETPLACE_LABEL] ?? m}</option>
              ))}
            </select>
            <div className="seg">
              {([7, 30, 90] as const).map((r) => (
                <button key={r} className={range === r ? "on" : ""} onClick={() => setRange(r)} type="button">
                  {r}d
                </button>
              ))}
            </div>
          </div>
        </header>
        <AreaChart points={revenue} kind="money" accent="violet" height={220} emptyLabel="Nenhuma venda capturada ainda — a linha aparece quando houver coleta de pedidos" />
      </section>

      <div className="grid2">
        <section className="card">
          <header className="card-head">
            <h2>Unidades vendidas por anúncio</h2>
            <span className="count">top {byListing.length}</span>
          </header>
          <BarChart points={byListing} kind="count" accent="teal" height={200} />
        </section>

        <section className="card">
          <header className="card-head">
            <h2>Qualidade dos dados</h2>
            <span className="tiny muted">proveniência de cada registro</span>
          </header>
          <Donut parts={qualityParts} total={totalPoints} />
        </section>
      </div>

      <section className="card">
        <header className="card-head">
          <div>
            <h2>Missões do dia</h2>
            <p>Impacto × urgência ÷ esforço. Cada missão cita o número que a justifica.</p>
          </div>
          <button className="btn ghost" onClick={onGenerateMissions} type="button">Gerar missões</button>
        </header>
        {missions.filter((m) => m.status === "OPEN").length === 0 ? (
          <p className="empty">Nenhuma missão aberta. Gere as missões depois de coletar dados de anúncios e pedidos.</p>
        ) : (
          <ol className="missions">
            {missions.filter((m) => m.status === "OPEN").slice(0, 5).map((m, i) => (
              <li key={m.id}>
                <div className="mission-rank">{i + 1}</div>
                <div className="mission-body">
                  <div className="mission-head">
                    <strong>{m.bottleneck}</strong>
                    <span className="pill">{m.pillar}</span>
                    <span className="score">score {m.score.toFixed(1)}</span>
                  </div>
                  <p className="mission-hyp">{m.hypothesis}</p>
                  <p className="tiny muted">Evidência: {m.evidence}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="grid2">
        <section className="card">
          <header className="card-head">
            <h2>Atenção agora</h2>
            <button className="btn xs ghost" onClick={() => goTo("anuncios")} type="button">ver anúncios</button>
          </header>
          {!listings || listings.alerts.length === 0 ? (
            <p className="empty">Nenhum alerta com os dados atuais. Sem captura, não há alerta — e é isso que a tela deve dizer.</p>
          ) : (
            <ul className="events">
              {listings.alerts.slice(0, 5).map((a) => (
                <li key={a.id}>
                  <span className={`badge badge-${a.severity === "critical" ? "bad" : a.severity === "attention" ? "warn" : "info"}`}>{a.severity}</span>
                  <div>
                    <strong>{a.title}</strong>
                    <p className="tiny muted">{a.detail} · {a.evidence}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <header className="card-head">
            <h2>Plano do cérebro</h2>
            <button className="btn xs ghost" onClick={() => goTo("cerebro")} type="button">abrir plano</button>
          </header>
          {!report || report.recommendations.length === 0 ? (
            <p className="empty">O cérebro não recomenda nada sem dado. Capture uma página para começar.</p>
          ) : (
            <ul className="events">
              {report.recommendations.slice(0, 4).map((r) => (
                <li key={r.id}>
                  <span className="pill">{r.area}</span>
                  <div>
                    <strong>{r.title}</strong>
                    <p className="tiny muted">{r.rationale}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid2">
        <section className="card">
          <header className="card-head">
            <h2>Anúncios</h2>
            <input placeholder="filtrar por título ou código" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 240 }} />
          </header>
          {filtered.length === 0 ? (
            <p className="empty">Nenhum anúncio capturado ainda.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Anúncio</th>
                    <th className="num">Preço</th>
                    <th className="num">Estoque</th>
                    <th className="num">Vendidos</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 12).map((a) => (
                    <tr key={a.entityRef}>
                      <td>{a.title ?? a.entityRef}</td>
                      <td className="num">{brl(a.priceCents)}</td>
                      <td className="num">{a.stock === null ? <Quality quality="NOT_COLLECTED" /> : a.stock}</td>
                      <td className="num">{a.metrics.find((m) => m.metric === "sold")?.latest ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <header className="card-head">
            <h2>Saúde do sistema</h2>
            <button className="btn xs ghost" onClick={() => goTo("sistema")} type="button">detalhes</button>
          </header>
          <ul className="facts">
            <li><span>Migrações</span><b>{health?.migrations.length ?? 0} aplicadas</b></li>
            <li><span>Auditoria</span><b>{health?.audit.ok ? `íntegra (${health.audit.total} eventos)` : "corrompida"}</b></li>
            <li><span>Gemini</span><b>{health?.gemini.configured ? `opcional, ${health.gemini.remaining ?? 0} consulta(s) hoje` : "não configurado (opcional)"}</b></li>
            <li><span>APIs</span><b>{credentials.length} credencial(is) · opcional</b></li>
            <li><span>Capturas nesta sessão</span><b>{recordings}</b></li>
          </ul>
        </section>
      </div>
    </>
  );
}

function Kpi({
  label,
  value,
  foot,
  tone,
  bar,
}: {
  label: string;
  value: string;
  foot: string;
  tone?: "ok" | "warn" | "bad";
  bar?: number;
}) {
  return (
    <div className={`kpi ${tone ?? ""}`}>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      <span className="kpi-foot">{foot}</span>
      {bar !== undefined && (
        <div className="bar">
          <i style={{ width: `${Math.max(2, Math.min(100, bar))}%` }} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ anúncios

function Listings({ listings, coverage, verified, totalPoints }: { listings: ListingsReply | null; coverage: number; verified: number; totalPoints: number }) {
  const [query, setQuery] = useState("");
  const [onlyIssues, setOnlyIssues] = useState(false);

  const rows = useMemo(() => {
    const all = listings?.listings ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((l) => {
      if (q && !`${l.title ?? ""} ${l.entityRef}`.toLowerCase().includes(q)) return false;
      if (onlyIssues && l.stock !== null && l.stock > 5 && l.priceCents !== null) return false;
      return true;
    });
  }, [listings, query, onlyIssues]);

  if (!listings || listings.listings.length === 0) {
    return (
      <Panel title="Anúncios" hint="Nada capturado ainda">
        <Empty>
          Nenhum anúncio no banco. Abra a lista de anúncios do vendedor no Chrome e use <strong>Capturar esta página</strong>.
        </Empty>
      </Panel>
    );
  }

  return (
    <>
      <div className="kpis small">
        <Kpi label="Anúncios" value={String(listings.listings.length)} foot="no banco local" />
        <Kpi label="Observações" value={String(totalPoints)} foot={`${verified} verificadas`} />
        <Kpi label="Qualidade" value={`${coverage}%`} foot="verificado sobre o total" bar={coverage} tone={coverage < 30 ? "warn" : "ok"} />
        <Kpi label="Alertas" value={String(listings.alerts.length)} foot="preço, estoque, dado" />
      </div>

      <Panel
        title="Catálogo capturado"
        hint="Cada linha mostra a qualidade do número: verificado, estimado, não coletado"
        aside={
          <div className="filters">
            <input placeholder="buscar título ou id" value={query} onChange={(e) => setQuery(e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
              só com pendência
            </label>
          </div>
        }
      >
        <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Anúncio</th>
              <th className="num">Preço</th>
              <th className="num">Variação</th>
              <th className="num">Estoque</th>
              <th>Última leitura</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => {
              const price = l.metrics.find((m) => m.metric === "price_cents");
              const stock = l.metrics.find((m) => m.metric === "stock");
              return (
                <tr key={l.entityRef}>
                  <td className="cell-title">
                    <strong title={l.title ?? undefined}>{l.title ?? <span className="muted">título não legível</span>}</strong>
                    <span className="mono tiny block muted">{l.entityRef}</span>
                  </td>
                  <td className="num">
                    <span className="stock">{brl(l.priceCents)}<Quality quality={price?.latestQuality} /></span>
                  </td>
                  <td className="num">
                    {price?.insufficientHistory ? (
                      <span className="muted">sem histórico</span>
                    ) : (
                      <span className={(price?.changePct ?? 0) < 0 ? "bad" : "ok"}>{pct(price?.changePct)}</span>
                    )}
                  </td>
                  <td className="num">
                    <span className="stock">
                      <span>{l.stock === null ? <span className="muted">não lido</span> : l.stock}</span>
                      {l.stock !== null && l.stock === 0 && <Badge tone="bad">esgotado</Badge>}
                      <Quality quality={stock?.latestQuality} />
                    </span>
                  </td>
                  <td className="muted">{when(price?.latestAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        {rows.length === 0 && <Empty>Nenhum anúncio casa com o filtro.</Empty>}
      </Panel>

      {listings.alerts.length > 0 && (
        <Panel title={`Alertas (${listings.alerts.length})`} hint="Cada alerta cita a evidência que o sustenta">
          <ul className="alerts wide">
            {listings.alerts.map((a) => (
              <li key={a.id} className={`sev-${a.severity}`}>
                <div className="alert-head">
                  <Badge tone={a.severity === "critical" ? "bad" : a.severity === "attention" ? "warn" : "info"}>
                    {a.severity === "critical" ? "crítico" : a.severity === "attention" ? "atenção" : "info"}
                  </Badge>
                  <strong>{a.title}</strong>
                </div>
                <p>{a.detail}</p>
                <small>{a.evidence}</small>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

// ------------------------------------------------------------ pedidos

function Orders({ sales, listings }: { sales: SalesStock | null; listings: ListingsReply | null }) {
  const byMkt = sales?.byMarketplace ?? {};
  const entries = Object.entries(byMkt);
  const max = Math.max(1, ...entries.map(([, v]) => v.totalCents));

  return (
    <>
      <div className="kpis">
        <Kpi label="Pedidos capturados" value={String(sales?.ordersCaptured ?? 0)} foot="entidade order" />
        <Kpi label="Com valor legível" value={String(sales?.ordersWithValue ?? 0)} foot="o resto é ilegível, não zero" tone={(sales?.ordersWithValue ?? 0) === 0 ? "warn" : undefined} />
        <Kpi label="Total capturado" value={brl(sales?.totalCents ?? 0)} foot="soma só do que tem valor" />
        <Kpi label="Marketplaces" value={String(entries.length)} foot={entries.map(([k]) => k).join(", ") || "nenhum"} />
      </div>

      <div className="cols">
        <Panel title="Vendas por marketplace" hint="Soma dos pedidos com valor legível">
          {entries.length === 0 ? (
            <Empty>Nenhum pedido capturado. Abra a página de pedidos no painel do vendedor e capture.</Empty>
          ) : (
            <ul className="bars">
              {entries.map(([name, v]) => (
                <li key={name}>
                  <span>{MARKETPLACE_LABEL[name as keyof typeof MARKETPLACE_LABEL] ?? name}</span>
                  <div className="bar"><i style={{ width: `${(v.totalCents / max) * 100}%` }} /></div>
                  <b>{brl(v.totalCents)}</b>
                  <small>{v.orders} pedido(s)</small>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Venda × estoque" hint="A conta que justifica ter capturado pedido">
          <ul className="facts">
            <li><span>Pedidos com valor</span><b>{sales?.ordersWithValue ?? 0}</b></li>
            <li><span>Produtos com estoque lido</span><b>{sales?.stockKnown ?? 0}</b></li>
            <li>
              <span>Cobertura</span>
              <b className={sales?.note ? "warn" : "ok"}>{sales?.note ? "não calculável" : "calculável"}</b>
            </li>
          </ul>
          {sales?.note && <p className="warn-text">{sales.note}</p>}
          {!sales?.note && (
            <p className="muted tiny">
              A cobertura de vendas é a razão entre o que saiu e o estoque lido. O produto não inventa esse número
              quando falta uma das pontas.
            </p>
          )}
        </Panel>
      </div>

      <Panel title="Estoque por anúncio" hint="Do que foi capturado; vazio significa não lido">
        {!listings || listings.listings.length === 0 ? (
          <Empty>Nenhum anúncio capturado ainda.</Empty>
        ) : (
          <div className="table-wrap">
        <table className="table">
            <thead>
              <tr><th>Anúncio</th><th className="num">Estoque</th><th className="num">Preço</th>
                <th>Leitura</th></tr>
            </thead>
            <tbody>
              {listings.listings.map((l) => {
                const stock = l.metrics.find((m) => m.metric === "stock");
                return (
                  <tr key={l.entityRef}>
                    <td>{l.title ?? <span className="muted">título não legível</span>}</td>
                    <td className="num">{l.stock === null ? <span className="muted">não lido</span> : l.stock} <Quality quality={stock?.latestQuality} /></td>
                    <td className="num">{brl(l.priceCents)}</td>
                    <td className="muted">{when(stock?.latestAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </Panel>
    </>
  );
}

// ------------------------------------------------------------ cérebro

function Plan({
  report,
  auditText,
  onAudit,
  busy,
  geminiConfigured,
}: {
  report: BrainReport | null;
  auditText: string | null;
  onAudit: () => void;
  busy: boolean;
  geminiConfigured: boolean;
}) {
  return (
    <>
      <div className="kpis">
        <Kpi label="Anúncios analisados" value={String(report?.listingsAnalyzed ?? 0)} foot="base do plano" />
        <Kpi label="Recomendações" value={String(report?.recommendations.length ?? 0)} foot="determinísticas e auditáveis" />
        <Kpi label="Pontos cegos" value={String(report?.blindSpots.length ?? 0)} foot="o que não dá para concluir" tone={(report?.blindSpots.length ?? 0) > 0 ? "warn" : undefined} />
        <Kpi label="Gemini" value={geminiConfigured ? "opcional" : "desligado"} foot={geminiConfigured ? "auditor externo com cota" : "o cérebro interno não depende dele"} />
      </div>

      <Panel
        title="Plano do cérebro"
        hint="IA interna: regra determinística sobre os dados do banco — nada de caixa-preta"
        aside={<span className="tiny muted">gerado em {when(report?.generatedAt)}</span>}
      >
        {!report || report.recommendations.length === 0 ? (
          <Empty>Nenhuma recomendação com os dados atuais. Isso pode significar duas coisas: tudo em ordem, ou dado insuficiente — veja os pontos cegos.</Empty>
        ) : (
          <ol className="recs big">
            {report.recommendations.map((r) => (
              <li key={r.id}>
                <div className="rec-head">
                  <span className={`area area-${r.area}`}>{r.area}</span>
                  <strong>{r.title}</strong>
                  <span className={`conf conf-${r.confidence}`}>confiança {r.confidence}</span>
                </div>
                <p>{r.rationale}</p>
                <ul className="actions">{r.actions.map((a) => <li key={a}>{a}</li>)}</ul>
                <small>Base: {r.evidence.join("; ")}</small>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      {report && report.blindSpots.length > 0 && (
        <Panel title={`O que não dá para concluir (${report.blindSpots.length})`} hint="Honestidade explícita: o que falta para decidir melhor">
          <ul className="blind-list">{report.blindSpots.map((b) => <li key={b}>{b}</li>)}</ul>
        </Panel>
      )}

      <Panel
        title="Auditoria externa (Gemini)"
        hint="Opcional. Consome cota; o produto inteiro funciona sem ele."
        aside={<Badge tone={geminiConfigured ? "ok" : "soft"}>{geminiConfigured ? "configurado" : "não configurado"}</Badge>}
      >
        <button className="btn ghost" onClick={onAudit} disabled={busy} type="button">Auditar com Gemini</button>
        {auditText && <pre className="audit">{auditText}</pre>}
      </Panel>
    </>
  );
}

// ------------------------------------------------------------ melhorias

function Improvements({ items, onDecide, busy }: { items: ImprovementRow[]; onDecide: (id: string, d: "APPROVED" | "REJECTED") => void; busy: boolean }) {
  const pending = items.filter((i) => i.status === "PROPOSED");

  return (
    <>
      <div className="kpis">
        <Kpi label="Propostas" value={String(items.length)} foot="histórico completo" />
        <Kpi label="Aguardando decisão" value={String(pending.length)} foot="só o proprietário aprova" tone={pending.length > 0 ? "warn" : undefined} />
        <Kpi label="Aprovadas" value={String(items.filter((i) => i.status === "APPROVED" || i.status === "APPLIED").length)} foot="aplicadas ou liberadas" />
        <Kpi label="Rejeitadas" value={String(items.filter((i) => i.status === "REJECTED").length)} foot="mantidas no registro" />
      </div>

      <Panel
        title="Central de Melhorias"
        hint="Nenhuma melhoria permanente é aplicada sem aprovação explícita do proprietário — validada no serviço local, não só escondendo o botão."
      >
        {items.length === 0 ? (
          <Empty>Nenhuma proposta registrada. As propostas nascem do cérebro quando ele encontra um padrão que vale mudar no produto.</Empty>
        ) : (
          <ul className="imps">
            {items.map((i) => (
              <li key={i.id}>
                <div className="imp-head">
                  <strong>{i.title}</strong>
                  <Badge tone={i.status === "PROPOSED" ? "warn" : i.status === "REJECTED" ? "bad" : "ok"}>{i.status}</Badge>
                </div>
                <p>{i.rationale}</p>
                <small className="muted">{i.kind} · {when(i.createdAt)}{i.decisionNote ? ` · ${i.decisionNote}` : ""}</small>
                {i.status === "PROPOSED" && (
                  <div className="row">
                    <button className="btn" onClick={() => onDecide(i.id, "APPROVED")} disabled={busy} type="button">Aprovar</button>
                    <button className="btn ghost" onClick={() => onDecide(i.id, "REJECTED")} disabled={busy} type="button">Rejeitar</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

// ------------------------------------------------------------ api

function ApiPage({
  catalog,
  credentials,
  onReload,
  setNotice,
  busy,
}: {
  catalog: ApiCatalog | null;
  credentials: CredentialRow[];
  onReload: () => void;
  setNotice: (s: string | null) => void;
  busy: boolean;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const spec: ConnectorSpec | undefined = catalog?.connectors.find((c) => c.marketplace === chosen);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!spec) return;
    const fd = new FormData(e.currentTarget);
    const publicFields: Record<string, string> = {};
    let secret = "";
    for (const f of spec.fields) {
      const v = String(fd.get(f.key) ?? "").trim();
      if (!v) continue;
      if (f.secret) secret = v;
      else publicFields[f.key] = v;
    }
    if (!secret) {
      setNotice("Informe o segredo do marketplace (token ou chave do app).");
      return;
    }
    try {
      await ask("api", "api.save", {
        marketplace: spec.marketplace,
        accountRef: publicFields.seller_id ?? publicFields.shop_id ?? publicFields.supplier_id ?? null,
        label: String(fd.get("label") ?? spec.name),
        publicFields,
        secret,
      });
      formRef.current?.reset();
      setChosen(null);
      setNotice(null);
      onReload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(id: string) {
    try {
      await ask("api", "api.remove", { id });
      onReload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <Panel
        title="API é opcional — e é importante entender por quê"
        hint="O produto analisa pela sessão já logada no Chrome. A API só acrescenta dado oficial do marketplace."
        aside={<Badge tone={catalog?.encryptionAvailable ? "ok" : "warn"}>{catalog?.encryptionAvailable ? "criptografia ativa" : "sem chave de criptografia"}</Badge>}
      >
        <div className="grid2">
          <div className="mini ok-card">
            <strong>Sem API (padrão)</strong>
            <span>Lê o painel do vendedor no navegador. Funciona hoje, sem cadastro em developer portal.</span>
            <Badge tone="ok">já funciona</Badge>
          </div>
          <div className="mini">
            <strong>Com API</strong>
            <span>Pedido confirmado pelo marketplace e estoque oficial. Exige app registrado e credencial.</span>
            <Badge tone="soft">acréscimo</Badge>
          </div>
        </div>
        {!catalog?.encryptionAvailable && (
          <p className="warn-text">
            O serviço ainda não tem chave de criptografia. Ele <strong>recusa</strong> gravar credencial nesse estado,
            em vez de guardar segredo em texto puro. Abra o serviço uma vez: a chave é criada em
            <span className="mono"> %LOCALAPPDATA%\LordMarketplacesAnalytics\api-key.txt</span>.
          </p>
        )}
      </Panel>

      <Panel title="Credenciais configuradas" hint="O segredo nunca volta para esta tela — só o status">
        {credentials.length === 0 ? (
          <Empty>Nenhuma credencial. Tudo bem: o produto funciona sem nenhuma.</Empty>
        ) : (
          <div className="table-wrap">
        <table className="table">
            <thead>
              <tr><th>Marketplace</th><th>Rótulo</th><th>Status</th><th>Última verificação</th><th></th></tr>
            </thead>
            <tbody>
              {credentials.map((c) => (
                <tr key={c.id}>
                  <td><strong>{catalog?.connectors.find((x) => x.marketplace === c.marketplace)?.name ?? c.marketplace}</strong></td>
                  <td>{c.label}<span className="mono tiny block">{Object.entries(c.publicFields).map(([k, v]) => `${k}=${v}`).join(" · ") || "—"}</span></td>
                  <td><Badge tone={c.status === "ACTIVE" ? "ok" : c.status === "INVALID" ? "bad" : "soft"}>{c.status}</Badge>{c.lastError && <span className="tiny block bad">{c.lastError}</span>}</td>
                  <td className="muted">{c.lastVerifiedAt ? when(c.lastVerifiedAt) : "nunca verificada"}</td>
                  <td><button className="link danger" onClick={() => void remove(c.id)} disabled={busy} type="button">remover</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Panel>

      <Panel title="Conectar uma API" hint="Cada marketplace tem suas regras; o formulário segue o que o portal de desenvolvedores exige">
        <div className="connectors">
          {catalog?.connectors.map((c) => (
            <button key={c.marketplace} className={`connector ${chosen === c.marketplace ? "on" : ""}`} onClick={() => setChosen(c.marketplace)} type="button">
              <strong>{c.name}</strong>
              <span>{c.authType}</span>
            </button>
          )) ?? <Empty>Catálogo indisponível: o serviço local não respondeu.</Empty>}
        </div>

        {spec && (
          <form className="api-form" ref={formRef} onSubmit={save}>
            <div className="api-howto">
              <strong>{spec.name}</strong>
              <p>{spec.howTo}</p>
              <a href={spec.docsUrl} target="_blank" rel="noreferrer">documentação oficial ↗</a>
            </div>
            <label className="field">
              <span>Rótulo (como você chama esta loja)</span>
              <input name="label" placeholder={spec.name} required />
            </label>
            <div className="grid2">
              {spec.fields.map((f) => (
                <label className="field" key={f.key}>
                  <span>{f.label}{f.required ? " *" : ""}{f.secret ? " (segredo)" : ""}</span>
                  <input
                    name={f.key}
                    type={f.secret ? "password" : "text"}
                    placeholder={f.hint}
                    required={f.required}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              ))}
            </div>
            <p className="tiny muted">
              O segredo é cifrado (AES-256-GCM) no banco local e nunca é devolvido a esta tela. A chave fica neste
              computador. Sem chave, a gravação é recusada.
            </p>
            <div className="row">
              <button className="btn" type="submit" disabled={busy}>Salvar credencial</button>
              <button className="btn ghost" type="button" onClick={() => setChosen(null)}>Cancelar</button>
            </div>
          </form>
        )}
      </Panel>
    </>
  );
}

// ------------------------------------------------------------ sistema

function System({ health, capture, onRefresh }: { health: HealthReply | null; capture: CaptureReply | null; onRefresh: () => void }) {
  return (
    <>
      <div className="kpis">
        <Kpi label="Serviço local" value={health?.ok ? "no ar" : "sem resposta"} foot={`v${health?.version ?? "—"}`} tone={health?.ok ? "ok" : "bad"} />
        <Kpi label="Auditoria" value={health?.audit.ok ? "íntegra" : "corrompida"} foot={`${health?.audit.total ?? 0} eventos encadeados`} tone={health?.audit.ok ? "ok" : "bad"} />
        <Kpi label="Migrações" value={String(health?.migrations.length ?? 0)} foot={health?.migrations.join(", ") ?? "—"} />
        <Kpi label="Gemini" value={health?.gemini.configured ? "configurado" : "desligado"} foot={health?.gemini.configured ? `${health.gemini.remaining ?? 0} consulta(s) hoje` : "produto funciona sem ele"} />
      </div>

      <div className="cols">
        <Panel title="Integridade" hint="O que o produto verifica, não o que ele promete">
          <ul className="facts">
            <li><span>Banco</span><b className="ok">SQLite local, WAL</b></li>
            <li><span>Cadeia de auditoria</span><b className={health?.audit.ok ? "ok" : "bad"}>{health?.audit.ok ? "hash encadeado válido" : `quebrada em ${health?.audit.brokenAtSeq}`}</b></li>
            <li><span>Proveniência</span><b className="ok">obrigatória no schema</b></li>
            <li><span>Dado simulado</span><b className="ok">não existe</b></li>
            <li><span>Vírgula entre zero e nulo</span><b className="ok">nulo nunca vira zero</b></li>
          </ul>
        </Panel>

        <Panel title="Última captura" aside={<button className="link" onClick={onRefresh} type="button">reconsultar →</button>}>
          {capture ? (
            <ul className="facts">
              <li><span>Resultado</span><b className="ok">{capture.outcome}</b></li>
              <li><span>Itens lidos</span><b>{capture.cardsParsed ?? capture.rowsParsed ?? 0}</b></li>
              <li><span>Observações</span><b>{capture.observationsWritten}</b></li>
              <li><span>Run</span><b className="mono tiny">{capture.runId.slice(0, 8)}…</b></li>
            </ul>
          ) : (
            <Empty>Ainda sem captura nesta sessão.</Empty>
          )}
        </Panel>
      </div>

      <Panel title="O que este software nunca faz" hint="Compromissos verificáveis no código, não slogans">
        <ul className="never">
          <li>Não pede, lê ou envia senha, cookie ou token de marketplace.</li>
          <li>Não usa endpoint privado nem replay de requisição.</li>
          <li>Não envia dado para nenhum servidor do fornecedor — não existe um.</li>
          <li>Não aplica melhoria permanente sem aprovação do proprietário, validada no serviço.</li>
          <li>Não apresenta dado simulado como real: campo não lido aparece como não lido.</li>
        </ul>
        <p className="tiny muted">Dados em <span className="mono">%LOCALAPPDATA%\LordMarketplacesAnalytics\data.db</span> — desinstalar não apaga: o dado é seu.</p>
      </Panel>
    </>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Dashboard />);
