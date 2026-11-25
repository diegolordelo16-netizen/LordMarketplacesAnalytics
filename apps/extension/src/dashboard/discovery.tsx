/**
 * Revisão da descoberta assistida.
 *
 * A tela é uma fila de trabalho: cada sugestão da IA chega com nota, motivo e
 * os sinais que puxaram a nota. Nada entra no monitoramento sem o dono decidir
 * aqui — aprovar é o único caminho.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ask, grabActiveTabHtml } from "./data.js";

type Relation = "DIRETO" | "SIMILAR" | "INDIRETO";
type Status = "PENDENTE" | "APROVADO" | "REJEITADO" | "DESCARTADO";

interface Product {
  id: string;
  entityRef: string;
  marketplace: string;
  title: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  attributes: Record<string, string>;
  priceCents: number | null;
}

interface Component {
  signal: string;
  weight: number;
  match: number;
  points: number;
  note: string;
}

interface Candidate {
  id: string;
  productId: string;
  marketplace: string;
  externalRef: string;
  url: string;
  title: string | null;
  seller: string | null;
  priceCents: number | null;
  relation: Relation;
  similarityBp: number;
  components: Component[];
  justification: string;
  status: Status;
  rejectionReason: string | null;
  competitorId: string | null;
  createdAt: string;
}

interface Stats {
  pending: number;
  approved: number;
  rejected: number;
  edited: number;
  decided: number;
  approvalRateBp: number | null;
}

const RELATION_LABEL: Record<Relation, string> = {
  DIRETO: "Direto",
  SIMILAR: "Similar",
  INDIRETO: "Indireto",
};

const MARKETPLACES: { id: string; label: string }[] = [
  { id: "mercadolivre", label: "Mercado Livre" },
  { id: "shopee", label: "Shopee" },
  { id: "amazon", label: "Amazon" },
  { id: "tiktokshop", label: "TikTok Shop" },
  { id: "magalu", label: "Magalu" },
  { id: "temu", label: "Temu" },
  { id: "shein", label: "Shein" },
  { id: "netshoes", label: "Netshoes" },
];

const pct = (bp: number) => `${(bp / 100).toFixed(1)}%`;
const brl = (cents: number | null) =>
  cents === null ? "—" : (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function DiscoveryPage({
  listings,
  busy,
  setBusy,
  setNotice,
  onChanged,
}: {
  listings: { entityRef: string; title: string | null; priceCents?: number | null }[];
  busy: boolean;
  setBusy: (v: boolean) => void;
  setNotice: (v: string | null) => void;
  onChanged: () => void;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [tab, setTab] = useState<"PENDENTE" | "APROVADO" | "REJEITADO">("PENDENTE");
  const [marketplace, setMarketplace] = useState("mercadolivre");
  const [reasons, setReasons] = useState<Record<string, string>>({});

  // Perfil do produto próprio: ou do catálogo já capturado, ou pelo link.
  const [form, setForm] = useState({ entityRef: "", title: "", brand: "", model: "", category: "", attributes: "" });

  const loadProducts = useCallback(async () => {
    try {
      const r = await ask<{ products: Product[] }>("discovery", "discovery.products");
      setProducts(r.products);
      if (!productId && r.products.length > 0) setProductId(r.products[0].id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, [productId, setNotice]);

  const loadCandidates = useCallback(async () => {
    if (!productId) {
      setCandidates([]);
      return;
    }
    try {
      const r = await ask<{ candidates: Candidate[]; stats: Stats }>("discovery", "discovery.candidates", {
        productId,
        status: tab,
      });
      setCandidates(r.candidates);
      setStats(r.stats);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, [productId, tab, setNotice]);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);
  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

  async function saveProduct() {
    setBusy(true);
    setNotice(null);
    try {
      const attributes = Object.fromEntries(
        form.attributes
          .split("\n")
          .map((line) => line.split(":"))
          .filter((parts) => parts.length >= 2)
          .map((parts) => [parts[0].trim(), parts.slice(1).join(":").trim()]),
      );
      const r = await ask<{ product: Product }>("discovery", "discovery.saveProduct", {
        entityRef: form.entityRef || `MANUAL-${Date.now()}`,
        title: form.title,
        brand: form.brand || null,
        model: form.model || null,
        category: form.category || null,
        attributes,
        marketplace,
        priceCents: listings.find((l) => l.entityRef === form.entityRef)?.priceCents ?? null,
      });
      setProductId(r.product.id);
      setForm({ entityRef: "", title: "", brand: "", model: "", category: "", attributes: "" });
      await loadProducts();
      setNotice("Produto salvo. Abra a busca no marketplace e clique em “Buscar concorrentes desta aba”.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function search() {
    setBusy(true);
    setNotice(null);
    try {
      const got = await grabActiveTabHtml();
      if ("error" in got) throw new Error(got.error);
      const r = await ask<{ seen: number; kept: number; note: string }>("discovery", "discovery.search", {
        productId,
        html: got.html,
        pageUrl: got.url,
        marketplace,
      });
      setTab("PENDENTE");
      await loadCandidates();
      setNotice(r.note);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, action: "approve" | "reject") {
    setBusy(true);
    setNotice(null);
    try {
      if (action === "approve") {
        await ask("discovery", "discovery.approve", { id });
        setNotice("Aprovado: o concorrente entrou no monitoramento contínuo.");
      } else {
        await ask("discovery", "discovery.reject", { id, reason: reasons[id] ?? null });
        setNotice("Rejeitado. A decisão fica registrada e passa a pesar nas próximas buscas.");
      }
      await loadCandidates();
      onChanged();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeRelation(id: string, relation: Relation) {
    setBusy(true);
    try {
      await ask("discovery", "discovery.edit", { id, relation, reason: "classificação corrigida na revisão" });
      await loadCandidates();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const product = products.find((p) => p.id === productId) ?? null;
  const cards = useMemo(() => candidates, [candidates]);

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">Pendentes de revisão</div>
          <div className="kpi-value">{stats?.pending ?? 0}</div>
          <div className="kpi-foot">aguardando a sua decisão</div>
        </div>
        <div className="kpi tone-teal">
          <div className="kpi-label">Aprovados</div>
          <div className="kpi-value">{stats?.approved ?? 0}</div>
          <div className="kpi-foot">em monitoramento</div>
        </div>
        <div className="kpi tone-rose">
          <div className="kpi-label">Rejeitados</div>
          <div className="kpi-value">{stats?.rejected ?? 0}</div>
          <div className="kpi-foot">decisões registradas</div>
        </div>
        <div className="kpi tone-violet">
          <div className="kpi-label">Precisão das sugestões</div>
          <div className="kpi-value">{stats?.approvalRateBp === null || stats === null ? "—" : pct(stats.approvalRateBp)}</div>
          <div className="kpi-foot">{stats?.decided ? `${stats.decided} decisões · ${stats.edited} correções` : "sem decisões ainda"}</div>
        </div>
      </div>

      <section className="card">
        <header className="card-head">
          <div>
            <h2>1 · Seu produto</h2>
            <p>Escolha um anúncio do seu catálogo ou descreva o produto. É a base da comparação.</p>
          </div>
        </header>
        {products.length > 0 && (
          <div className="link-row">
            <select value={productId} onChange={(e) => setProductId(e.target.value)} aria-label="Produto base">
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.entityRef})
                </option>
              ))}
            </select>
            <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)} aria-label="Marketplace da busca">
              {MARKETPLACES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <button className="btn" type="button" onClick={() => void search()} disabled={busy || !productId}>
              {busy ? "Lendo a aba…" : "Buscar concorrentes desta aba"}
            </button>
          </div>
        )}
        {product && (
          <p className="hint">
            Base: <b>{product.title}</b>
            {product.brand ? ` · ${product.brand}` : ""}
            {product.model ? ` · ${product.model}` : ""}
            {product.category ? ` · ${product.category}` : ""}
          </p>
        )}
        <div className="link-row">
          <select
            value={form.entityRef}
            onChange={(e) => {
              const chosen = listings.find((l) => l.entityRef === e.target.value);
              setForm({ ...form, entityRef: e.target.value, title: chosen?.title ?? form.title });
            }}
            aria-label="Anúncio do catálogo"
          >
            <option value="">Anúncio do catálogo (opcional)</option>
            {listings.map((l) => (
              <option key={l.entityRef} value={l.entityRef}>
                {l.title ?? l.entityRef}
              </option>
            ))}
          </select>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Título do seu produto" />
          <input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} placeholder="Marca" />
          <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="Modelo (ex.: FF302)" />
          <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Categoria" />
        </div>
        <textarea
          value={form.attributes}
          onChange={(e) => setForm({ ...form, attributes: e.target.value })}
          placeholder={"Características confirmadas, uma por linha\nTipo: capacete fechado\nViseira: fumê"}
          rows={3}
        />
        <div className="link-row">
          <button className="btn" type="button" onClick={() => void saveProduct()} disabled={busy || form.title.trim().length < 3}>
            Salvar produto
          </button>
        </div>
        <p className="hint">
          A busca é feita pela sua sessão: abra a página de resultados do marketplace numa aba, volte aqui e clique em
          “Buscar concorrentes desta aba”. Nada é enviado para fora deste computador e nenhuma API do marketplace é usada.
        </p>
      </section>

      <section className="card">
        <header className="card-head">
          <h2>2 · Revisão</h2>
          <div className="seg">
            {(["PENDENTE", "APROVADO", "REJEITADO"] as const).map((s) => (
              <button key={s} type="button" className={tab === s ? "on" : ""} onClick={() => setTab(s)}>
                {s === "PENDENTE" ? "Pendentes" : s === "APROVADO" ? "Aprovados" : "Rejeitados"}
              </button>
            ))}
          </div>
        </header>
        {cards.length === 0 ? (
          <p className="empty">
            {tab === "PENDENTE"
              ? "Nenhuma sugestão aguardando. Faça uma busca acima para a IA encontrar concorrentes."
              : "Nada nesta lista ainda."}
          </p>
        ) : (
          <div className="cand-list">
            {cards.map((c) => (
              <article key={c.id} className="cand">
                <div className="cand-head">
                  <div>
                    <h3>{c.title ?? c.externalRef}</h3>
                    <p className="tiny muted">
                      {MARKETPLACES.find((m) => m.id === c.marketplace)?.label ?? c.marketplace} · {c.externalRef} ·{" "}
                      {brl(c.priceCents)}
                      {c.seller ? ` · ${c.seller}` : ""}
                    </p>
                  </div>
                  <div className="cand-score">
                    <b>{pct(c.similarityBp)}</b>
                    <span className={`pill rel-${c.relation.toLowerCase()}`}>{RELATION_LABEL[c.relation]}</span>
                  </div>
                </div>
                <p className="cand-why">{c.justification}</p>
                <details className="cand-signals">
                  <summary>Como a nota foi calculada</summary>
                  <ul>
                    {c.components.map((comp) => (
                      <li key={comp.signal}>
                        <b>{comp.signal}</b>: {comp.note} <span className="tiny muted">({comp.points > 0 ? "+" : ""}{comp.points} pontos)</span>
                      </li>
                    ))}
                  </ul>
                </details>
                <div className="cand-actions">
                  {c.status === "PENDENTE" && (
                    <>
                      <button className="btn" type="button" disabled={busy} onClick={() => void decide(c.id, "approve")}>
                        Aprovar
                      </button>
                      <input
                        value={reasons[c.id] ?? ""}
                        onChange={(e) => setReasons({ ...reasons, [c.id]: e.target.value })}
                        placeholder="Motivo da rejeição (opcional)"
                      />
                      <button className="btn ghost" type="button" disabled={busy} onClick={() => void decide(c.id, "reject")}>
                        Rejeitar
                      </button>
                      <select
                        value={c.relation}
                        onChange={(e) => void changeRelation(c.id, e.target.value as Relation)}
                        aria-label="Classificar concorrente"
                      >
                        <option value="DIRETO">Direto</option>
                        <option value="SIMILAR">Similar</option>
                        <option value="INDIRETO">Indireto</option>
                      </select>
                    </>
                  )}
                  {c.status !== "PENDENTE" && (
                    <span className="tiny muted">
                      {c.status === "APROVADO" ? "em monitoramento" : "rejeitado"}
                      {c.rejectionReason ? ` · ${c.rejectionReason}` : ""}
                    </span>
                  )}
                  <a className="link" href={c.url} target="_blank" rel="noreferrer">
                    Abrir anúncio ↗
                  </a>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
