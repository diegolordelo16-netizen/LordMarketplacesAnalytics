/**
 * Telas novas do dashboard: inteligência competitiva, editor de descrição
 * (título travado) e financeiro.
 *
 * Todas trabalham com dado real do serviço local. Quando o dado não existe, a
 * tela mostra a limitação — não um número de enfeite.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ask, grabActiveTabHtml } from "./data.js";
import { AreaChart, BarChart, Sparkline, type Point } from "./charts.js";

const brl = (cents: number | null | undefined) =>
  cents === null || cents === undefined
    ? "—"
    : (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const when = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
};

// ============================================================ concorrentes

export interface CompetitorView {
  id: string;
  marketplace: string;
  externalRef: string;
  url: string;
  title: string | null;
  seller: string | null;
  linkedEntityRef: string | null;
  status: "MONITORING" | "PAUSED" | "DELETED";
  notes: string | null;
  lastCollectedAt: string | null;
  snapshots: number;
  latest: {
    collectedAt: string;
    priceCents: number | null;
    listPriceCents: number | null;
    soldCount: number | null;
    rating: number | null;
    reviewsCount: number | null;
    stockText: string | null;
    shippingText: string | null;
    quality: string;
  } | null;
  change: { pricePct: number | null; soldDelta: number | null; ratingDelta: number | null; reviewsDelta: number | null; firstObservation: boolean } | null;
}

interface HistoryRow {
  collectedAt: string;
  priceCents: number | null;
  soldCount: number | null;
  rating: number | null;
  reviewsCount: number | null;
  stockText: string | null;
}

interface EventRow {
  id: string;
  competitorId: string;
  kind: string;
  severity: "INFO" | "ATTENTION" | "CRITICAL";
  summary: string;
  evidence: string;
  detectedAt: string;
}

const EVENT_TONE: Record<string, string> = { CRITICAL: "bad", ATTENTION: "warn", INFO: "ok" };

export function CompetitorsPage({
  listings,
  busy,
  setBusy,
  setNotice,
  onChanged,
}: {
  listings: { entityRef: string; title: string | null }[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setNotice: (s: string | null) => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<CompetitorView[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [url, setUrl] = useState("");
  const [detected, setDetected] = useState<{ marketplace: string; externalRef: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [detailEvents, setDetailEvents] = useState<EventRow[]>([]);
  const [linkTo, setLinkTo] = useState("");

  const reload = useCallback(async () => {
    try {
      const [list, ev] = await Promise.all([
        ask<{ competitors: CompetitorView[] }>("competitor", "competitor.list"),
        ask<{ events: EventRow[] }>("competitor", "competitor.events", { limit: 30 }),
      ]);
      setRows(list.competitors);
      setEvents(ev.events);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, [setNotice]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function parseLink(value: string) {
    setUrl(value);
    setDetected(null);
    if (value.trim().length < 12) return;
    try {
      const r = await ask<{ parsed: { marketplace: string; externalRef: string } }>("competitor", "competitor.parseLink", { url: value });
      setDetected(r.parsed);
    } catch {
      setDetected(null);
    }
  }

  async function add() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await ask<{ competitor: CompetitorView }>("competitor", "competitor.add", {
        url,
        linkedEntityRef: linkTo || undefined,
      });
      setUrl("");
      setLinkTo("");
      setDetected(null);
      setSelected(r.competitor.id);
      await reload();
      onChanged();
      setNotice("Anúncio salvo para monitoramento. Abra o link no navegador e use “Coletar dados desta aba” para a primeira leitura.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string) {
    setSelected(id);
    try {
      const d = await ask<{ competitor: CompetitorView; history: HistoryRow[]; events: EventRow[] }>(
        "competitor",
        "competitor.detail",
        { id },
      );
      setHistory(d.history);
      setDetailEvents(d.events);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Coleta a partir da aba ativa do navegador. O usuário abre o anúncio do
   * concorrente, volta aqui e clica: é a sessão dele lendo a página dele.
   */
  async function collect(id: string) {
    setBusy(true);
    setNotice(null);
    try {
      const got = await grabActiveTabHtml();
      if ("error" in got) throw new Error(got.error);
      const r = await ask<{ snapshot: { quality: string }; events: EventRow[] }>("competitor", "competitor.collect", {
        id,
        html: got.html,
        pageUrl: got.url,
      });
      await open(id);
      await reload();
      setNotice(
        r.snapshot.quality === "NOT_COLLECTED"
          ? "A página abriu, mas nenhum dado do anúncio foi legível (layout diferente ou bloqueio). Nada foi gravado como zero."
          : `Leitura gravada${r.events.length > 0 ? ` · ${r.events.length} mudança(s) detectada(s)` : ""}.`,
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(id: string, status: "MONITORING" | "PAUSED" | "DELETED") {
    setBusy(true);
    try {
      await ask("competitor", "competitor.status", { id, status });
      await reload();
      if (status === "DELETED" && selected === id) setSelected(null);
      onChanged();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function link(id: string, entityRef: string) {
    setBusy(true);
    try {
      await ask("competitor", "competitor.link", { id, entityRef: entityRef || null });
      await open(id);
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const selectedRow = rows.find((r) => r.id === selected) ?? null;
  const pricePoints: Point[] = useMemo(
    () => [...history].reverse().map((h) => ({ label: dayLabel(h.collectedAt), value: h.priceCents })),
    [history],
  );
  const soldPoints: Point[] = useMemo(
    () => [...history].reverse().map((h) => ({ label: dayLabel(h.collectedAt), value: h.soldCount })),
    [history],
  );

  return (
    <>
      <div className="kpis">
        <KpiCard label="Monitorados" value={String(rows.filter((r) => r.status === "MONITORING").length)} foot="em acompanhamento" tone="violet" />
        <KpiCard label="Pausados" value={String(rows.filter((r) => r.status === "PAUSED").length)} foot="sem coleta automática" tone="amber" />
        <KpiCard label="Leituras" value={String(rows.reduce((a, r) => a + r.snapshots, 0))} foot="histórico append-only" tone="teal" />
        <KpiCard
          label="Mudanças"
          value={String(events.length)}
          foot="eventos detectados"
          tone={events.some((e) => e.severity === "CRITICAL") ? "rose" : "violet"}
        />
      </div>

      <section className="card">
        <header className="card-head">
          <div>
            <h2>Adicionar concorrente por link</h2>
            <p>Cole o link do anúncio. O marketplace é identificado pelo próprio link — nada é enviado para fora deste computador.</p>
          </div>
        </header>
        <div className="link-row">
          <input
            value={url}
            onChange={(e) => void parseLink(e.target.value)}
            placeholder="https://produto.mercadolivre.com.br/MLB-1234567890-..."
            spellCheck={false}
          />
          <select value={linkTo} onChange={(e) => setLinkTo(e.target.value)}>
            <option value="">Relacionar ao meu produto (opcional)</option>
            {listings.map((l) => (
              <option key={l.entityRef} value={l.entityRef}>
                {l.title ?? l.entityRef}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => void add()} disabled={busy || !detected} type="button">
            Salvar para monitoramento
          </button>
        </div>
        {detected && (
          <p className="hint ok">
            Reconhecido: <b>{detected.marketplace}</b> · anúncio <code>{detected.externalRef}</code>
          </p>
        )}
        <p className="hint">
          A leitura é feita pela sua sessão: abra o anúncio no navegador e clique em <b>Coletar dados desta aba</b> na lista
          abaixo. O sistema não usa API do marketplace, nem pede senha, cookie ou token.
        </p>
      </section>

      <section className="card">
        <header className="card-head">
          <h2>Concorrentes monitorados</h2>
          <span className="count">{rows.length}</span>
        </header>
        {rows.length === 0 ? (
          <p className="empty">Nenhum concorrente cadastrado ainda. Cole o primeiro link acima.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Anúncio</th>
                  <th>Marketplace</th>
                  <th className="num">Preço</th>
                  <th className="num">Variação</th>
                  <th className="num">Vendidos</th>
                  <th className="num">Avaliação</th>
                  <th>Última leitura</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={selected === r.id ? "on" : ""}>
                    <td>
                      <button className="linkbtn" onClick={() => void open(r.id)} type="button">
                        {r.title ?? r.externalRef}
                      </button>
                      <div className="tiny muted">{r.seller ?? "vendedor não legível"}</div>
                    </td>
                    <td>
                      <span className="pill">{r.marketplace}</span>
                    </td>
                    <td className="num">{brl(r.latest?.priceCents)}</td>
                    <td className={`num ${r.change?.pricePct && r.change.pricePct < 0 ? "down" : r.change?.pricePct ? "up" : ""}`}>
                      {r.change?.pricePct === null || r.change?.pricePct === undefined
                        ? r.change?.firstObservation
                          ? "1ª leitura"
                          : "—"
                        : `${r.change.pricePct > 0 ? "+" : ""}${r.change.pricePct.toFixed(1)}%`}
                    </td>
                    <td className="num">{r.latest?.soldCount ?? "—"}</td>
                    <td className="num">{r.latest?.rating ?? "—"}</td>
                    <td className="tiny">{when(r.lastCollectedAt)}</td>
                    <td className="actions">
                      <button className="btn xs" onClick={() => void collect(r.id)} disabled={busy} type="button">
                        Coletar
                      </button>
                      <button
                        className="btn xs ghost"
                        onClick={() => void toggle(r.id, r.status === "PAUSED" ? "MONITORING" : "PAUSED")}
                        disabled={busy}
                        type="button"
                      >
                        {r.status === "PAUSED" ? "Retomar" : "Pausar"}
                      </button>
                      <button className="btn xs ghost" onClick={() => void toggle(r.id, "DELETED")} disabled={busy} type="button">
                        Excluir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedRow && (
        <section className="card">
          <header className="card-head">
            <div>
              <h2>{selectedRow.title ?? selectedRow.externalRef}</h2>
              <p>
                {selectedRow.marketplace} · <a href={selectedRow.url} target="_blank" rel="noreferrer">abrir anúncio</a> ·{" "}
                {selectedRow.snapshots} {selectedRow.snapshots === 1 ? "leitura" : "leituras"}
              </p>
            </div>
            <select value={selectedRow.linkedEntityRef ?? ""} onChange={(e) => void link(selectedRow.id, e.target.value)}>
              <option value="">Sem vínculo com meu produto</option>
              {listings.map((l) => (
                <option key={l.entityRef} value={l.entityRef}>
                  {l.title ?? l.entityRef}
                </option>
              ))}
            </select>
          </header>

          <div className="grid2">
            <div className="mini">
              <h3>Histórico de preço</h3>
              <AreaChart points={pricePoints} kind="money" accent="violet" emptyLabel="Só há uma leitura — histórico começa na segunda" />
            </div>
            <div className="mini">
              <h3>Vendidos acumulados</h3>
              <AreaChart points={soldPoints} kind="count" accent="teal" emptyLabel="Vendidos não legível nas leituras" />
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Leitura</th>
                  <th className="num">Preço</th>
                  <th className="num">Vendidos</th>
                  <th className="num">Nota</th>
                  <th className="num">Avaliações</th>
                  <th>Estoque</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.collectedAt}>
                    <td className="tiny">{when(h.collectedAt)}</td>
                    <td className="num">{brl(h.priceCents)}</td>
                    <td className="num">{h.soldCount ?? "—"}</td>
                    <td className="num">{h.rating ?? "—"}</td>
                    <td className="num">{h.reviewsCount ?? "—"}</td>
                    <td className="tiny">{h.stockText ?? "não legível"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {detailEvents.length > 0 && (
            <ul className="events">
              {detailEvents.map((e) => (
                <li key={e.id}>
                  <span className={`badge badge-${EVENT_TONE[e.severity]}`}>{e.severity}</span>
                  <div>
                    <strong>{e.summary}</strong>
                    <p className="tiny muted">{e.evidence} · {when(e.detectedAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="card">
        <header className="card-head">
          <h2>Mudanças detectadas</h2>
          <span className="count">{events.length}</span>
        </header>
        {events.length === 0 ? (
          <p className="empty">
            Nenhuma mudança ainda. Eventos nascem da comparação entre duas leituras do mesmo anúncio — a primeira leitura
            nunca gera alerta.
          </p>
        ) : (
          <ul className="events">
            {events.map((e) => {
              const comp = rows.find((r) => r.id === e.competitorId);
              return (
                <li key={e.id}>
                  <span className={`badge badge-${EVENT_TONE[e.severity]}`}>{e.severity}</span>
                  <div>
                    <strong>{e.summary}</strong>
                    <p className="tiny muted">
                      {comp?.title ?? comp?.externalRef ?? "concorrente"} · {e.evidence} · {when(e.detectedAt)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

// ============================================================ descrição

interface Proposal {
  id: string;
  marketplace: string;
  entityRef: string;
  titleOriginal: string;
  descriptionBefore: string;
  descriptionAfter: string;
  additions: { text: string; reason: string; source: string }[];
  status: "PROPOSED" | "APPROVED" | "REJECTED" | "APPLIED";
  createdAt: string;
}

export function DescriptionPage({
  listings,
  busy,
  setBusy,
  setNotice,
}: {
  listings: { entityRef: string; title: string | null; priceCents: number | null }[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setNotice: (s: string | null) => void;
}) {
  const [entityRef, setEntityRef] = useState("");
  const [description, setDescription] = useState("");
  const [facts, setFacts] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [diff, setDiff] = useState<{ kind: "same" | "added"; text: string }[]>([]);
  const [items, setItems] = useState<Proposal[]>([]);

  const reload = useCallback(async () => {
    try {
      const r = await ask<{ proposals: Proposal[] }>("edit", "edit.list", { limit: 20 });
      setItems(r.proposals);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, [setNotice]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function propose() {
    setBusy(true);
    setNotice(null);
    try {
      const knownFacts: Record<string, string> = {};
      for (const line of facts.split("\n")) {
        const [k, ...rest] = line.split(":");
        if (k && rest.length > 0) knownFacts[k.trim().toLowerCase()] = rest.join(":").trim();
      }
      const r = await ask<{ proposal: Proposal; diff: { kind: "same" | "added"; text: string }[] }>(
        "edit",
        "edit.propose",
        { marketplace: "mercadolivre", entityRef, description, knownFacts },
      );
      setProposal(r.proposal);
      setDiff(r.diff);
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, status: "APPROVED" | "REJECTED" | "APPLIED") {
    setBusy(true);
    try {
      const r = await ask<{ proposal: Proposal }>("edit", "edit.decide", { id, status });
      if (proposal?.id === id) setProposal(r.proposal);
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const chosen = listings.find((l) => l.entityRef === entityRef);

  return (
    <>
      <section className="card lock-card">
        <div className="lock-icon">🔒</div>
        <div>
          <h2>O título nunca é alterado</h2>
          <p>
            Este módulo otimiza apenas a descrição. O título entra como referência e o serviço recusa qualquer proposta
            que tente mudá-lo — a trava está no backend, não só na tela.
          </p>
        </div>
      </section>

      <section className="card">
        <header className="card-head">
          <h2>Complementar descrição</h2>
        </header>
        <div className="grid2">
          <label className="field">
            <span>Anúncio</span>
            <select
              value={entityRef}
              onChange={(e) => {
                setEntityRef(e.target.value);
                setProposal(null);
              }}
            >
              <option value="">Selecione um anúncio capturado</option>
              {listings.map((l) => (
                <option key={l.entityRef} value={l.entityRef}>
                  {l.title ?? l.entityRef}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Título original (somente leitura)</span>
            <input value={chosen?.title ?? ""} readOnly className="readonly" />
          </label>
        </div>
        <label className="field">
          <span>Descrição atual (cole a descrição do anúncio)</span>
          <textarea rows={7} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          <span>Dados confirmados do produto — um por linha, no formato <code>campo: valor</code></span>
          <textarea
            rows={4}
            value={facts}
            onChange={(e) => setFacts(e.target.value)}
            placeholder={"tecido: Composição 100% algodão\nvoltagem: Bivolt 110V/220V"}
          />
        </label>
        <button className="btn" onClick={() => void propose()} disabled={busy || !entityRef || description.trim().length < 20} type="button">
          Gerar proposta
        </button>
        <p className="hint">
          Só entra o que estiver nos dados confirmados. O que falta vira lacuna para você preencher — a IA não inventa
          característica do produto.
        </p>
      </section>

      {proposal && (
        <section className="card">
          <header className="card-head">
            <h2>Antes e depois</h2>
            <span className={`badge badge-${proposal.status === "PROPOSED" ? "warn" : proposal.status === "REJECTED" ? "bad" : "ok"}`}>
              {proposal.status}
            </span>
          </header>
          <div className="diff-grid">
            <div className="diff-col">
              <h3>Original</h3>
              <pre className="diff-pre">{proposal.descriptionBefore}</pre>
            </div>
            <div className="diff-col">
              <h3>Complementada</h3>
              <pre className="diff-pre">
                {diff.map((line, i) => (
                  <span key={i} className={line.kind === "added" ? "diff-added" : undefined}>
                    {line.kind === "added" ? "+ " : "  "}
                    {line.text}
                    {"\n"}
                  </span>
                ))}
              </pre>
            </div>
          </div>
          {proposal.additions.length > 0 && (
            <ul className="additions">
              {proposal.additions.map((a, i) => (
                <li key={i}>
                  <strong>{a.text}</strong>
                  <span className="tiny muted">
                    {a.reason} · fonte: {a.source}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {proposal.additions.length === 0 && (
            <p className="hint warn">
              Nenhum acréscimo comprovável: os dados confirmados não cobrem as lacunas deste produto. Preencha os campos
              acima e gere de novo.
            </p>
          )}
          <div className="row">
            <button className="btn" onClick={() => void decide(proposal.id, "APPROVED")} disabled={busy || proposal.status !== "PROPOSED"} type="button">
              Aprovar
            </button>
            <button className="btn ghost" onClick={() => void decide(proposal.id, "REJECTED")} disabled={busy || proposal.status !== "PROPOSED"} type="button">
              Rejeitar
            </button>
            <button className="btn ghost" onClick={() => void decide(proposal.id, "APPLIED")} disabled={busy || proposal.status !== "APPROVED"} type="button">
              Marcar como aplicada no anúncio
            </button>
          </div>
          <p className="hint">
            Aprovar não altera o anúncio: a aplicação é feita por você no marketplace, e o registro fica no histórico com
            o texto antes e depois.
          </p>
        </section>
      )}

      <section className="card">
        <header className="card-head">
          <h2>Histórico de propostas</h2>
          <span className="count">{items.length}</span>
        </header>
        {items.length === 0 ? (
          <p className="empty">Nenhuma proposta gerada ainda.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Anúncio</th>
                  <th>Título (inalterado)</th>
                  <th>Acréscimos</th>
                  <th>Estado</th>
                  <th>Gerada</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id} className="clickable" onClick={() => { setProposal(p); setDiff(diffFrom(p)); }}>
                    <td>{p.entityRef}</td>
                    <td className="tiny">{p.titleOriginal}</td>
                    <td className="num">{p.additions.length}</td>
                    <td>
                      <span className={`badge badge-${p.status === "PROPOSED" ? "warn" : p.status === "REJECTED" ? "bad" : "ok"}`}>{p.status}</span>
                    </td>
                    <td className="tiny">{when(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/** Diff local da proposta já gravada: nada é gerado de novo ao abrir. */
function diffFrom(p: Proposal): { kind: "same" | "added"; text: string }[] {
  const before = new Set(p.descriptionBefore.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  return p.descriptionAfter
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((line) => ({ kind: before.has(line.trim()) ? ("same" as const) : ("added" as const), text: line }));
}

// ============================================================ financeiro

interface MarginReply {
  margin: {
    entityRef: string;
    priceCents: number;
    costCents: number | null;
    packagingCents: number;
    commissionCents: number;
    taxCents: number;
    fixedFeeCents: number;
    freightCents: number;
    contributionCents: number | null;
    marginBp: number | null;
    minMarginBp: number;
    status: "CALCULATED" | "NOT_COLLECTED";
    missing: string[];
    formula: string;
  };
  scenarios: { priceCents: number; contributionCents: number | null; marginBp: number | null; belowFloor: boolean }[];
}

export function FinancePage({
  listings,
  busy,
  setBusy,
  setNotice,
}: {
  listings: { entityRef: string; title: string | null; priceCents: number | null }[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setNotice: (s: string | null) => void;
}) {
  const [entityRef, setEntityRef] = useState("");
  const [form, setForm] = useState({ cost: "", packaging: "", commission: "", tax: "", fixedFee: "", freight: "", minMargin: "15" });
  const [data, setData] = useState<MarginReply | null>(null);

  const chosen = listings.find((l) => l.entityRef === entityRef);

  async function load(ref = entityRef) {
    if (!ref) return;
    try {
      const r = await ask<MarginReply>("finance", "finance.margin", { entityRef: ref });
      setData(r);
    } catch (err) {
      setData(null);
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      await ask("finance", "finance.saveCost", {
        entityRef,
        costCents: form.cost ? Math.round(Number(form.cost.replace(",", ".")) * 100) : null,
        packagingCents: form.packaging ? Math.round(Number(form.packaging.replace(",", ".")) * 100) : null,
        commissionBp: form.commission ? Math.round(Number(form.commission.replace(",", ".")) * 100) : null,
        taxBp: form.tax ? Math.round(Number(form.tax.replace(",", ".")) * 100) : null,
        fixedFeeCents: form.fixedFee ? Math.round(Number(form.fixedFee.replace(",", ".")) * 100) : null,
        freightCents: form.freight ? Math.round(Number(form.freight.replace(",", ".")) * 100) : null,
        minMarginBp: form.minMargin ? Math.round(Number(form.minMargin.replace(",", ".")) * 100) : null,
      });
      await load();
      setNotice("Custo gravado com data de vigência. Cálculos antigos continuam com o custo da época.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const m = data?.margin;

  return (
    <>
      <section className="card">
        <header className="card-head">
          <div>
            <h2>Margem real por anúncio</h2>
            <p>Preço menos custo, embalagem, comissão, imposto, taxa fixa e frete. Ads é decisão separada.</p>
          </div>
        </header>
        <label className="field">
          <span>Anúncio</span>
          <select value={entityRef} onChange={(e) => { setEntityRef(e.target.value); setData(null); void load(e.target.value); }}>
            <option value="">Selecione um anúncio</option>
            {listings.map((l) => (
              <option key={l.entityRef} value={l.entityRef}>
                {l.title ?? l.entityRef} {l.priceCents !== null ? `· ${brl(l.priceCents)}` : ""}
              </option>
            ))}
          </select>
        </label>
        {chosen && chosen.priceCents === null && <p className="hint warn">Este anúncio não tem preço coletado — sem preço não há margem.</p>}

        <div className="cost-grid">
          <label className="field"><span>Custo do produto (R$)</span><input value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} inputMode="decimal" /></label>
          <label className="field"><span>Embalagem (R$)</span><input value={form.packaging} onChange={(e) => setForm({ ...form, packaging: e.target.value })} inputMode="decimal" /></label>
          <label className="field"><span>Comissão (%)</span><input value={form.commission} onChange={(e) => setForm({ ...form, commission: e.target.value })} inputMode="decimal" /></label>
          <label className="field"><span>Imposto (%)</span><input value={form.tax} onChange={(e) => setForm({ ...form, tax: e.target.value })} inputMode="decimal" /></label>
          <label className="field"><span>Taxa fixa (R$)</span><input value={form.fixedFee} onChange={(e) => setForm({ ...form, fixedFee: e.target.value })} inputMode="decimal" /></label>
          <label className="field"><span>Frete pago por você (R$)</span><input value={form.freight} onChange={(e) => setForm({ ...form, freight: e.target.value })} inputMode="decimal" /></label>
          <label className="field"><span>Margem mínima (%)</span><input value={form.minMargin} onChange={(e) => setForm({ ...form, minMargin: e.target.value })} inputMode="decimal" /></label>
        </div>
        <button className="btn" onClick={() => void save()} disabled={busy || !entityRef} type="button">Salvar custo</button>
      </section>

      {m && (
        <>
          <div className="kpis">
            <KpiCard label="Preço" value={brl(m.priceCents)} foot="coletado do anúncio" tone="violet" />
            <KpiCard
              label="Contribuição"
              value={m.contributionCents === null ? "sem custo" : brl(m.contributionCents)}
              foot={m.status === "NOT_COLLECTED" ? "cadastre o custo para calcular" : "por venda"}
              tone={m.contributionCents !== null && m.contributionCents < 0 ? "rose" : "teal"}
            />
            <KpiCard
              label="Margem"
              value={m.marginBp === null ? "—" : `${(m.marginBp / 100).toFixed(1)}%`}
              foot={`piso ${(m.minMarginBp / 100).toFixed(1)}%`}
              tone={m.marginBp !== null && m.marginBp < m.minMarginBp ? "rose" : "teal"}
            />
            <KpiCard label="Custo do produto" value={m.costCents === null ? "não informado" : brl(m.costCents)} foot="versionado por data" tone="amber" />
          </div>

          <section className="card">
            <header className="card-head">
              <h2>De onde vem cada centavo</h2>
              <span className="tiny muted">{m.formula}</span>
            </header>
            <BarChart
              points={[
                { label: "Preço", value: m.priceCents },
                { label: "Custo", value: m.costCents },
                { label: "Embalagem", value: m.packagingCents },
                { label: "Comissão", value: m.commissionCents },
                { label: "Imposto", value: m.taxCents },
                { label: "Taxa fixa", value: m.fixedFeeCents },
                { label: "Frete", value: m.freightCents },
                { label: "Contribuição", value: m.contributionCents },
              ]}
              kind="money"
              accent="violet"
            />
            {m.missing.length > 0 && <p className="hint warn">Faltando: {m.missing.join(", ")} — sem isso a margem não é calculada.</p>}
          </section>

          <section className="card">
            <header className="card-head">
              <h2>Cenários de preço</h2>
              <span className="tiny muted">margem mínima respeitada?</span>
            </header>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Preço</th>
                    <th className="num">Contribuição</th>
                    <th className="num">Margem</th>
                    <th>Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {data.scenarios.map((s) => (
                    <tr key={s.priceCents}>
                      <td>{brl(s.priceCents)}</td>
                      <td className="num">{brl(s.contributionCents)}</td>
                      <td className="num">{s.marginBp === null ? "—" : `${(s.marginBp / 100).toFixed(1)}%`}</td>
                      <td>
                        <span className={`badge badge-${s.belowFloor ? "bad" : "ok"}`}>{s.belowFloor ? "abaixo do piso" : "dentro do piso"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">Simulação não altera preço. Alterar preço é ação à parte, com aprovação.</p>
          </section>
        </>
      )}
    </>
  );
}

// ============================================================ missões

export interface MissionView {
  id: string;
  entityRef: string | null;
  pillar: string;
  bottleneck: string;
  hypothesis: string;
  evidence: string;
  impactCents: number | null;
  impactPct: number | null;
  effort: number;
  urgency: number;
  risk: string;
  score: number;
  status: "OPEN" | "DONE" | "DISMISSED";
}

export function MissionsPage({
  missions,
  busy,
  onGenerate,
  onDecide,
}: {
  missions: MissionView[];
  busy: boolean;
  onGenerate: () => void;
  onDecide: (id: string, status: "DONE" | "DISMISSED") => void;
}) {
  return (
    <>
      <section className="card">
        <header className="card-head">
          <div>
            <h2>Missões do dia</h2>
            <p>No máximo cinco ações, ordenadas por impacto × urgência ÷ esforço. Cada uma nasce de um número coletado.</p>
          </div>
          <button className="btn" onClick={onGenerate} disabled={busy} type="button">Gerar missões</button>
        </header>
        {missions.length === 0 ? (
          <p className="empty">Nenhuma missão gerada para hoje. Clique em “Gerar missões” depois de coletar dados.</p>
        ) : (
          <ol className="missions">
            {missions.map((m, i) => (
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
                  <div className="mission-meta">
                    <span>Impacto {m.impactCents === null ? (m.impactPct === null ? "não estimável" : `${m.impactPct.toFixed(1)}%`) : brl(m.impactCents)}</span>
                    <span>Esforço {m.effort}/5</span>
                    <span>Urgência {m.urgency}/5</span>
                    <span className="tiny">Risco: {m.risk}</span>
                  </div>
                  {m.status === "OPEN" && (
                    <div className="row">
                      <button className="btn xs" onClick={() => onDecide(m.id, "DONE")} disabled={busy} type="button">Concluir</button>
                      <button className="btn xs ghost" onClick={() => onDecide(m.id, "DISMISSED")} disabled={busy} type="button">Dispensar</button>
                    </div>
                  )}
                  {m.status !== "OPEN" && <span className={`badge badge-${m.status === "DONE" ? "ok" : "warn"}`}>{m.status}</span>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

// ============================================================ card de KPI

export function KpiCard({
  label,
  value,
  foot,
  tone = "violet",
  spark,
}: {
  label: string;
  value: string;
  foot?: string;
  tone?: string;
  spark?: (number | null)[];
}) {
  return (
    <div className={`kpi tone-${tone}`}>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {foot && <span className="kpi-foot">{foot}</span>}
      {spark && <Sparkline values={spark} tone={tone} />}
    </div>
  );
}
