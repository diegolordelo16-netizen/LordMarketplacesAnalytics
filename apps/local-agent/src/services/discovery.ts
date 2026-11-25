/**
 * Descoberta assistida de concorrentes.
 *
 * Como funciona, sem enfeite:
 *  1. O produto próprio vira uma assinatura: marca, modelo, categoria,
 *     atributos e as palavras do título.
 *  2. A busca é feita pela sessão do usuário (a aba que ele abriu no
 *     marketplace). O serviço recebe o HTML da página de resultados e lê os
 *     anúncios visíveis — não chama API nenhuma.
 *  3. Cada anúncio recebe uma nota de similaridade explicável, em componentes.
 *     A nota nunca é um número solto: vem com o que puxou para cima e para
 *     baixo, e a relação (DIRETO/SIMILAR/INDIRETO) sai dos componentes.
 *  4. O aprendizado não é promessa: as decisões do dono viram ajustes de nota
 *     aplicados na busca seguinte. Rejeitar um padrão reduz a nota de anúncios
 *     parecidos; aprovar aumenta. Os números do ajuste são limitados e
 *     visíveis na justificativa.
 *
 * O que este módulo NÃO faz: dizer que "treinou um modelo". Ele aplica regras
 * de classificação aprendidas do histórico — e é isso que está escrito aqui.
 */
import { randomUUID } from "node:crypto";
import type { LocalDatabase } from "../database/db.js";
import { parseMoneyToCents } from "../adapters/orders.js";
import type { CompetitorRow, CompetitorService } from "./competitors.js";

export type Relation = "DIRETO" | "SIMILAR" | "INDIRETO";
export type CandidateStatus = "PENDENTE" | "APROVADO" | "REJEITADO" | "DESCARTADO";

export interface ProductProfile {
  id: string;
  entityRef: string;
  marketplace: string;
  title: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  attributes: Record<string, string>;
  variations: string[];
  imageUrl: string | null;
  priceCents: number | null;
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScoreComponent {
  /** O que foi comparado. */
  signal: string;
  /** Peso do sinal na nota final (pode ser negativo no aprendizado). */
  weight: number;
  /** 0 a 1: quanto esse sinal bateu. */
  match: number;
  /** Pontos que o sinal somou (weight * match * 10000). */
  points: number;
  /** Frase pronta para o usuário: "marca igual (Norisk)". */
  note: string;
}

export interface Candidate {
  id: string;
  productId: string;
  marketplace: string;
  externalRef: string;
  url: string;
  title: string | null;
  seller: string | null;
  priceCents: number | null;
  imageUrl: string | null;
  relation: Relation;
  similarityBp: number;
  components: ScoreComponent[];
  justification: string;
  status: CandidateStatus;
  origin: string;
  rejectionReason: string | null;
  reviewedAt: string | null;
  competitorId: string | null;
  createdAt: string;
}

export interface ScrapedListing {
  externalRef: string;
  url: string;
  title: string;
  seller: string | null;
  priceCents: number | null;
  imageUrl: string | null;
}

// ------------------------------------------------------------------ utilidades

const STOP = new Set([
  "de","da","do","das","dos","com","para","por","e","em","no","na","nos","nas","um","uma",
  "o","a","os","as","kit","novo","nova","original","promocao","promoção","frete","gratis","grátis",
  "envio","imediato","pronta","entrega","tamanho","cor","unidade","unidades",
]);

/** Palavras que importam de um título: sem acento, sem conectivo, sem número solto. */
export function keywords(title: string): string[] {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .filter((w) => !/^\d+$/.test(w));
}

/** Códigos de modelo: sequências com letra e número (ff302, a15, mlb1234). */
export function modelTokens(title: string): string[] {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && /[a-z]/.test(w) && /\d/.test(w));
}

function overlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const hits = a.filter((w) => setB.has(w)).length;
  return hits / Math.max(a.length, b.length);
}

// -------------------------------------------------------------- perfil do produto

interface ProfileInput {
  entityRef: string;
  marketplace?: string;
  title: string;
  brand?: string | null;
  model?: string | null;
  category?: string | null;
  attributes?: Record<string, string> | null;
  variations?: string[] | null;
  imageUrl?: string | null;
  priceCents?: number | null;
  url?: string | null;
}

export class DiscoveryService {
  constructor(
    private readonly db: LocalDatabase,
    private readonly competitors: CompetitorService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ------------------------------------------------------------ produto meu

  saveProduct(input: ProfileInput): ProductProfile {
    const title = (input.title ?? "").trim();
    if (title.length < 3) throw new Error("informe o título do seu produto");
    const entityRef = (input.entityRef ?? "").trim();
    if (!entityRef) throw new Error("informe o código do anúncio (ou selecione um do seu catálogo)");
    const now = this.now().toISOString();
    const existing = this.db.raw().prepare(`SELECT id FROM product_profiles WHERE entity_ref = ?`).get(entityRef) as
      | { id: string }
      | undefined;

    const values: (string | number | null)[] = [
      input.marketplace ?? "mercadolivre",
      title,
      input.brand?.trim() || null,
      input.model?.trim() || null,
      input.category?.trim() || null,
      JSON.stringify(input.attributes ?? {}),
      JSON.stringify(input.variations ?? []),
      input.imageUrl ?? null,
      input.priceCents ?? null,
      input.url ?? null,
      now,
    ];

    if (existing) {
      this.db
        .raw()
        .prepare(
          `UPDATE product_profiles SET marketplace = ?, title = ?, brand = ?, model = ?, category = ?,
             attributes = ?, variations = ?, image_url = ?, price_cents = ?, url = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(...values, existing.id);
      return this.product(existing.id) as ProductProfile;
    }

    const id = randomUUID();
    this.db
      .raw()
      .prepare(
        `INSERT INTO product_profiles
           (id, entity_ref, marketplace, title, brand, model, category, attributes, variations, image_url, price_cents, url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, entityRef, ...values, now);
    return this.product(id) as ProductProfile;
  }

  product(id: string): ProductProfile | null {
    const r = this.db.raw().prepare(`SELECT * FROM product_profiles WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.toProduct(r) : null;
  }

  products(): ProductProfile[] {
    const rows = this.db
      .raw()
      .prepare(`SELECT * FROM product_profiles ORDER BY updated_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.toProduct(r));
  }

  private toProduct(r: Record<string, unknown>): ProductProfile {
    const parse = <T>(v: unknown, fallback: T): T => {
      try {
        return typeof v === "string" && v ? (JSON.parse(v) as T) : fallback;
      } catch {
        return fallback;
      }
    };
    return {
      id: String(r.id),
      entityRef: String(r.entity_ref),
      marketplace: String(r.marketplace),
      title: String(r.title),
      brand: (r.brand as string) ?? null,
      model: (r.model as string) ?? null,
      category: (r.category as string) ?? null,
      attributes: parse<Record<string, string>>(r.attributes, {}),
      variations: parse<string[]>(r.variations, []),
      imageUrl: (r.image_url as string) ?? null,
      priceCents: r.price_cents === null || r.price_cents === undefined ? null : Number(r.price_cents),
      url: (r.url as string) ?? null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  // -------------------------------------------------------------- aprendizado

  /**
   * Ajustes aprendidos do histórico de decisões do dono.
   *
   * Não é "modelo treinado": é uma tabela de ajustes por palavra e por marca,
   * calculada a partir de aprovações e rejeições, limitada a ±2.000 pontos-base
   * (20% da nota) para uma decisão isolada não sequestrar a busca. Palavras e
   * marcas são contadas só em decisões do mesmo produto ou da mesma categoria.
   */
  learnedAdjustments(product: ProductProfile): {
    words: Map<string, { approved: number; rejected: number }>;
    brands: Map<string, { approved: number; rejected: number }>;
  } {
    const rows = this.db
      .raw()
      .prepare(
        `SELECT f.decision, f.product_signature, c.title, c.seller
         FROM review_feedback f
         LEFT JOIN competitor_candidates c ON c.id = f.candidate_id`,
      )
      .all() as { decision: string; product_signature: string; title: string | null }[];

    const signature = productSignature(product);
    const words = new Map<string, { approved: number; rejected: number }>();
    const brands = new Map<string, { approved: number; rejected: number }>();
    const bump = (map: Map<string, { approved: number; rejected: number }>, key: string, approved: boolean) => {
      const cur = map.get(key) ?? { approved: 0, rejected: 0 };
      if (approved) cur.approved += 1;
      else cur.rejected += 1;
      map.set(key, cur);
    };

    for (const row of rows) {
      // Só decisões de produtos com a mesma assinatura ensinam algo para este.
      if (row.product_signature !== signature) continue;
      const approved = row.decision === "APROVADO";
      for (const w of keywords(row.title ?? "")) bump(words, w, approved);
    }
    return { words, brands };
  }

  /** Quantas decisões existem e qual a taxa de aprovação — o painel mostra isso. */
  stats(): {
    pending: number;
    approved: number;
    rejected: number;
    edited: number;
    approvalRateBp: number | null;
    decided: number;
  } {
    const byStatus = this.db
      .raw()
      .prepare(`SELECT status, COUNT(*) AS n FROM competitor_candidates GROUP BY status`)
      .all() as { status: string; n: number }[];
    const get = (s: string) => byStatus.find((r) => r.status === s)?.n ?? 0;
    const edited = (
      this.db.raw().prepare(`SELECT COUNT(*) AS n FROM review_feedback WHERE decision = 'EDITADO'`).get() as {
        n: number;
      }
    ).n;
    const approved = get("APROVADO");
    const rejected = get("REJEITADO");
    const decided = approved + rejected;
    return {
      pending: get("PENDENTE"),
      approved,
      rejected,
      edited: Number(edited),
      decided,
      approvalRateBp: decided > 0 ? Math.round((approved / decided) * 10000) : null,
    };
  }

  // ------------------------------------------------------------------ pontuação

  /**
   * Nota de similaridade com componentes explicáveis.
   *
   * Pesos: modelo 32, marca 18, palavras do título 25, categoria 10,
   * atributos 10, preço 5 — e o ajuste aprendido entra como componente
   * próprio, nunca escondido dentro dos outros.
   */
  score(product: ProductProfile, listing: ScrapedListing, learned = this.learnedAdjustments(product)): {
    similarityBp: number;
    relation: Relation;
    components: ScoreComponent[];
    justification: string;
  } {
    const components: ScoreComponent[] = [];
    const add = (signal: string, weight: number, match: number, note: string) => {
      components.push({ signal, weight, match: Number(match.toFixed(3)), points: Math.round(weight * match * 100), note });
    };

    // 1. Modelo: o sinal mais forte. "FF302" no anúncio é quase prova.
    const myModels = new Set([...(product.model ? modelTokens(product.model) : []), ...modelTokens(product.title)]);
    const theirModels = modelTokens(listing.title);
    // "FF 302" (com espaço) é o mesmo modelo que "FF302": o número colado no
    // código anterior também conta.
    const joined = listing.title
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\b([a-z]{1,6})\s+(\d{2,5})\b/g, "$1$2");
    const modelHit = theirModels.find((m) => myModels.has(m)) ?? modelTokens(joined).find((m) => myModels.has(m)) ?? null;
    add("modelo", 32, modelHit ? 1 : 0, modelHit ? `mesmo código de modelo (${modelHit})` : "nenhum código de modelo em comum");

    // 2. Marca: pode estar no título ou no vendedor.
    const brandWord = product.brand ? keywords(product.brand)[0] ?? null : null;
    const haystack = `${listing.title} ${listing.seller ?? ""}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const brandHit = brandWord ? haystack.includes(brandWord) : false;
    add("marca", 18, brandHit ? 1 : 0, brandHit ? `marca presente no anúncio (${product.brand})` : "marca não aparece no anúncio");

    // 3. Palavras do título: semelhança de produto mesmo com título diferente.
    const wordOverlap = overlap(keywords(product.title), keywords(listing.title));
    add(
      "palavras do título",
      25,
      wordOverlap,
      wordOverlap > 0
        ? `${Math.round(wordOverlap * 100)}% das palavras importantes em comum`
        : "nenhuma palavra importante em comum",
    );

    // 4. Categoria declarada (o usuário informou; a busca usa como dica).
    const catWords = product.category ? keywords(product.category) : [];
    const catHit = catWords.length > 0 ? overlap(catWords, keywords(listing.title)) : 0;
    add("categoria", 10, catHit, catHit > 0 ? `categoria aparece no anúncio (${product.category})` : "categoria não citada");

    // 5. Atributos confirmados: cada um que aparece no título conta.
    const attrKeys = Object.entries(product.attributes).filter(([, v]) => v && v.trim().length > 2);
    if (attrKeys.length > 0) {
      const hits = attrKeys.filter(([, v]) => keywords(v).some((w) => haystack.includes(w))).length;
      add("atributos", 10, hits / attrKeys.length, `${hits} de ${attrKeys.length} atributos aparecem no anúncio`);
    } else {
      add("atributos", 10, 0, "sem atributos cadastrados no seu produto");
    }

    // 6. Preço: faixa parecida indica mesmo segmento (não é prova de nada).
    if (product.priceCents !== null && listing.priceCents !== null && product.priceCents > 0) {
      const ratio = Math.min(listing.priceCents, product.priceCents) / Math.max(listing.priceCents, product.priceCents);
      add("faixa de preço", 5, ratio, `preço do concorrente é ${Math.round(ratio * 100)}% do seu`);
    } else {
      add("faixa de preço", 5, 0, "preço não legível para comparar");
    }

    // 7. Aprendizado: o que o dono já aprovou ou rejeitou com título parecido.
    const words = keywords(listing.title);
    let learnedPoints = 0;
    const notes: string[] = [];
    for (const w of words) {
      const seen = learned.words.get(w);
      if (!seen) continue;
      const delta = (seen.approved - seen.rejected) * 120;
      learnedPoints += Math.max(-400, Math.min(400, delta));
      if (seen.rejected > seen.approved) notes.push(`você já rejeitou anúncios com "${w}"`);
      else if (seen.approved > seen.rejected) notes.push(`você já aprovou anúncios com "${w}"`);
    }
    learnedPoints = Math.max(-2000, Math.min(2000, learnedPoints));
    if (learnedPoints !== 0) {
      components.push({
        signal: "aprendizado",
        weight: 0,
        match: 0,
        points: learnedPoints,
        note: notes.slice(0, 2).join("; "),
      });
    }

    const raw = components.reduce((a, c) => a + c.points, 0);
    const similarityBp = Math.max(0, Math.min(10000, raw));

    // Relação: modelo igual e marca igual é direto; acima de 45% é similar;
    // o resto é indireto (mesma categoria disputando público).
    const modelPoints = components.find((c) => c.signal === "modelo")?.points ?? 0;
    const brandPoints = components.find((c) => c.signal === "marca")?.points ?? 0;
    const relation: Relation =
      modelPoints >= 3200 && brandPoints >= 1800 ? "DIRETO" : similarityBp >= 4500 ? "SIMILAR" : "INDIRETO";

    const positives = components.filter((c) => c.points > 0).sort((a, b) => b.points - a.points);
    const justification =
      positives.length > 0
        ? `${positives.slice(0, 3).map((c) => c.note).join("; ")}.`
        : "Nenhuma característica em comum encontrada além da categoria; provavelmente não é concorrente.";

    return { similarityBp, relation, components, justification };
  }

  // -------------------------------------------------------------------- busca

  /**
   * Analisa a página de resultados que o usuário abriu e guarda as sugestões.
   *
   * Recebe o HTML (da sessão do usuário), lê os anúncios, pontua cada um e
   * grava o que passou do corte mínimo. Nada nasce aprovado: tudo entra como
   * PENDENTE. Anúncio já conhecido (aprovado, rejeitado ou pendente) não é
   * duplicado — a sugestão existente é atualizada com a nota nova.
   */
  discoverFromHtml(
    productId: string,
    html: string,
    options: { marketplace: string; pageUrl: string; minSimilarityBp?: number },
  ): { candidates: Candidate[]; seen: number; kept: number; note: string } {
    const product = this.product(productId);
    if (!product) throw new Error("produto não encontrado");
    const min = options.minSimilarityBp ?? 2500;
    const scraped = scrapeListings(html, options.marketplace);
    const learned = this.learnedAdjustments(product);
    const created: Candidate[] = [];

    for (const listing of scraped) {
      const scored = this.score(product, listing, learned);
      if (scored.similarityBp < min) continue;
      created.push(
        this.saveCandidate(product, listing, {
          marketplace: options.marketplace,
          url: listing.url || options.pageUrl,
          ...scored,
        }),
      );
    }

    created.sort((a, b) => b.similarityBp - a.similarityBp);
    return {
      candidates: created,
      seen: scraped.length,
      kept: created.length,
      note:
        scraped.length === 0
          ? "A página não trouxe anúncios legíveis (pode ser bloqueio, carregamento por rolagem ou layout diferente). Nada foi inventado."
          : `${scraped.length} anúncios lidos, ${created.length} sugeridos para revisão.`,
    };
  }

  private saveCandidate(
    product: ProductProfile,
    listing: ScrapedListing,
    data: {
      marketplace: string;
      url: string;
      similarityBp: number;
      relation: Relation;
      components: ScoreComponent[];
      justification: string;
    },
  ): Candidate {
    const now = this.now().toISOString();
    const existing = this.db
      .raw()
      .prepare(`SELECT id, status FROM competitor_candidates WHERE product_id = ? AND marketplace = ? AND external_ref = ?`)
      .get(product.id, data.marketplace, listing.externalRef) as { id: string; status: string } | undefined;

    if (existing) {
      // Rejeitado não volta a ser pendente sozinho: a decisão do dono fica.
      const keepStatus = existing.status === "REJEITADO" || existing.status === "APROVADO";
      this.db
        .raw()
        .prepare(
          `UPDATE competitor_candidates
             SET title = COALESCE(?, title), seller = COALESCE(?, seller), price_cents = COALESCE(?, price_cents),
                 image_url = COALESCE(?, image_url), similarity_bp = ?, relation = ?, components = ?,
                 justification = ?, updated_at = ?, status = ?
           WHERE id = ?`,
        )
        .run(
          listing.title || null,
          listing.seller,
          listing.priceCents,
          listing.imageUrl,
          data.similarityBp,
          data.relation,
          JSON.stringify(data.components),
          data.justification,
          now,
          keepStatus ? existing.status : "PENDENTE",
          existing.id,
        );
      return this.candidate(existing.id) as Candidate;
    }

    const id = randomUUID();
    this.db
      .raw()
      .prepare(
        `INSERT INTO competitor_candidates
           (id, product_id, marketplace, external_ref, url, title, seller, price_cents, image_url,
            relation, similarity_bp, components, justification, status, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDENTE', 'IA', ?, ?)`,
      )
      .run(
        id,
        product.id,
        data.marketplace,
        listing.externalRef,
        data.url,
        listing.title || null,
        listing.seller,
        listing.priceCents,
        listing.imageUrl,
        data.relation,
        data.similarityBp,
        JSON.stringify(data.components),
        data.justification,
        now,
        now,
      );
    return this.candidate(id) as Candidate;
  }

  // ---------------------------------------------------------------- decisões

  /**
   * Aprova uma sugestão: ela vira concorrente monitorado.
   *
   * Aprovar é o único caminho de sugestão para monitoramento, e é o próprio
   * dono que faz — o serviço não aprova nada sozinho. O produto próprio do
   * perfil é ligado ao concorrente automaticamente, porque foi para isso que
   * a sugestão foi feita.
   */
  approve(
    candidateId: string,
    options: { linkedEntityRef?: string | null; relation?: Relation; title?: string | null },
  ): { candidate: Candidate; competitor: CompetitorRow } {
    const candidate = this.candidate(candidateId);
    if (!candidate) throw new Error("sugestão não encontrada");
    const product = this.product(candidate.productId);
    if (!product) throw new Error("produto do perfil não encontrado");
    const now = this.now().toISOString();
    const relation = options.relation ?? candidate.relation;

    const competitor = this.competitors.add(candidate.url || `${candidate.marketplace}:${candidate.externalRef}`, {
      linkedEntityRef: options.linkedEntityRef ?? product.entityRef,
      notes: `Sugerido pela IA (similaridade ${(candidate.similarityBp / 100).toFixed(1)}%) e aprovado na revisão.`,
      parsed: { marketplace: candidate.marketplace, externalRef: candidate.externalRef, url: candidate.url, kind: "unknown" },
    });

    this.db
      .raw()
      .prepare(
        `UPDATE competitor_candidates SET status = 'APROVADO', relation = ?, competitor_id = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(relation, competitor.id, now, now, candidateId);

    this.recordFeedback(candidate, product, "APROVADO", relation, relation, null);
    return { candidate: this.candidate(candidateId) as Candidate, competitor };
  }

  /** Rejeita com motivo: a decisão fica registrada e ensina a próxima busca. */
  reject(candidateId: string, reason: string | null): Candidate {
    const candidate = this.candidate(candidateId);
    if (!candidate) throw new Error("sugestão não encontrada");
    const product = this.product(candidate.productId);
    const now = this.now().toISOString();
    this.db
      .raw()
      .prepare(
        `UPDATE competitor_candidates SET status = 'REJEITADO', rejection_reason = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(reason?.trim() || null, now, now, candidateId);
    if (product) this.recordFeedback(candidate, product, "REJEITADO", candidate.relation, candidate.relation, reason);
    return this.candidate(candidateId) as Candidate;
  }

  /** Edita a classificação antes de decidir: conta como correção do dono. */
  editRelation(candidateId: string, relation: Relation, reason: string | null): Candidate {
    const candidate = this.candidate(candidateId);
    if (!candidate) throw new Error("sugestão não encontrada");
    const product = this.product(candidate.productId);
    const now = this.now().toISOString();
    this.db.raw().prepare(`UPDATE competitor_candidates SET relation = ?, updated_at = ? WHERE id = ?`).run(relation, now, candidateId);
    if (product && relation !== candidate.relation) {
      this.recordFeedback(candidate, product, "EDITADO", candidate.relation, relation, reason);
    }
    return this.candidate(candidateId) as Candidate;
  }

  /** Troca o produto próprio ao qual a sugestão pertence. */
  reassign(candidateId: string, productId: string): Candidate {
    if (!this.product(productId)) throw new Error("produto de destino não encontrado");
    this.db
      .raw()
      .prepare(`UPDATE competitor_candidates SET product_id = ?, updated_at = ? WHERE id = ?`)
      .run(productId, this.now().toISOString(), candidateId);
    return this.candidate(candidateId) as Candidate;
  }

  private recordFeedback(
    candidate: Candidate,
    product: ProductProfile,
    decision: "APROVADO" | "REJEITADO" | "EDITADO",
    before: string,
    after: string,
    reason: string | null,
  ): void {
    this.db
      .raw()
      .prepare(
        `INSERT INTO review_feedback
           (id, candidate_id, product_id, marketplace, decision, relation_before, relation_after,
            similarity_bp, reason, product_signature, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        candidate.id,
        product.id,
        candidate.marketplace,
        decision,
        before,
        after,
        candidate.similarityBp,
        reason?.trim() || null,
        productSignature(product),
        this.now().toISOString(),
      );
  }

  /** Histórico de decisões do dono, mais recente primeiro. */
  feedback(limit = 100): {
    id: string;
    candidateId: string;
    decision: string;
    relationBefore: string | null;
    relationAfter: string | null;
    reason: string | null;
    createdAt: string;
  }[] {
    const rows = this.db
      .raw()
      .prepare(`SELECT * FROM review_feedback ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      candidateId: String(r.candidate_id),
      decision: String(r.decision),
      relationBefore: (r.relation_before as string) ?? null,
      relationAfter: (r.relation_after as string) ?? null,
      reason: (r.reason as string) ?? null,
      createdAt: String(r.created_at),
    }));
  }

  // ---------------------------------------------------------------- consulta

  candidate(id: string): Candidate | null {
    const r = this.db.raw().prepare(`SELECT * FROM competitor_candidates WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.toCandidate(r) : null;
  }

  candidates(filter: { productId?: string; status?: CandidateStatus | "TODOS" } = {}): Candidate[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.productId) {
      where.push("product_id = ?");
      params.push(filter.productId);
    }
    if (filter.status && filter.status !== "TODOS") {
      where.push("status = ?");
      params.push(filter.status);
    }
    const sql = `SELECT * FROM competitor_candidates ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY similarity_bp DESC, created_at DESC`;
    const rows = this.db.raw().prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.toCandidate(r));
  }

  private toCandidate(r: Record<string, unknown>): Candidate {
    let components: ScoreComponent[] = [];
    try {
      components = JSON.parse(String(r.components)) as ScoreComponent[];
    } catch {
      components = [];
    }
    return {
      id: String(r.id),
      productId: String(r.product_id),
      marketplace: String(r.marketplace),
      externalRef: String(r.external_ref),
      url: String(r.url),
      title: (r.title as string) ?? null,
      seller: (r.seller as string) ?? null,
      priceCents: r.price_cents === null || r.price_cents === undefined ? null : Number(r.price_cents),
      imageUrl: (r.image_url as string) ?? null,
      relation: r.relation as Relation,
      similarityBp: Number(r.similarity_bp),
      components,
      justification: String(r.justification),
      status: r.status as CandidateStatus,
      origin: String(r.origin),
      rejectionReason: (r.rejection_reason as string) ?? null,
      reviewedAt: (r.reviewed_at as string) ?? null,
      competitorId: (r.competitor_id as string) ?? null,
      createdAt: String(r.created_at),
    };
  }
}

/** Assinatura do produto: o que define "produtos parecidos com este". */
export function productSignature(product: ProductProfile): string {
  const parts = [product.brand ?? "", product.category ?? ""]
    .join("|")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  return parts === "|" ? "sem-assinatura" : parts;
}

// ------------------------------------------------------- leitura de resultados

/**
 * Lê os anúncios de uma página de resultados/busca.
 *
 * Trabalha com os formatos que aparecem de fato nas páginas de listagem:
 * links de anúncio, título, preço. O que não for legível fica NULL — a página
 * de resultados raramente traz vendidos e avaliação.
 */
export function scrapeListings(html: string, marketplace: string): ScrapedListing[] {
  const out = new Map<string, ScrapedListing>();
  const unescape = (s: string) =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

  // Cada item é um bloco <a href="...">...</a> com título e, às vezes, preço.
  // O laço é explícito: um <a> que não rende anúncio não pode "engolir" o
  // próximo, como acontecia quando o fecho vinha depois do limite de 1200
  // caracteres (o título de um item caía no bloco do anterior).
  const openRe = /<a\b[^>]*href="([^"]+)"[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(html)) !== null) {
    const href = match[1];
    const close = html.indexOf("</a>", openRe.lastIndex);
    const inner = html.slice(openRe.lastIndex, close === -1 ? openRe.lastIndex + 1200 : Math.min(close, openRe.lastIndex + 1200));
    const ref = listingRef(href, marketplace);
    if (!ref || out.has(ref)) continue;
    const title =
      inner.match(/<h2[^>]*>([\s\S]{5,300}?)<\/h2>/i)?.[1] ??
      inner.match(/<span[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]{5,300}?)<\/span>/i)?.[1] ??
      html.slice(match.index, openRe.lastIndex).match(/title="([^"]{5,300})"/i)?.[1];
    const cleanTitle = title ? unescape(title) : "";
    if (cleanTitle.length < 5) continue;
    const priceRaw =
      inner.match(/andes-money-amount__fraction[^>]*>([\d.]+)</i)?.[1] ??
      inner.match(/R\$\s*([\d.]+,\d{2})/)?.[1] ??
      null;
    const img = inner.match(/<img[^>]*src="([^"]+)"/i)?.[1] ?? null;
    out.set(ref, {
      externalRef: ref,
      url: href.startsWith("http") ? href : `https://${href.replace(/^\//, "")}`,
      title: cleanTitle,
      seller: null,
      priceCents: priceRaw ? parseMoneyToCents(`R$ ${priceRaw}`) : null,
      imageUrl: img,
    });
  }
  return [...out.values()];
}

/** Código do anúncio a partir do link, por marketplace. */
function listingRef(href: string, marketplace: string): string | null {
  if (marketplace === "mercadolivre" || marketplace === "mercadolibre") {
    const m = href.match(/(ML[A-Z]-?\d{6,})/i);
    return m ? m[1].toUpperCase().replace("-", "") : null;
  }
  if (marketplace === "shopee") {
    const m = href.match(/-i\.(\d+)\.(\d+)/);
    return m ? `${m[1]}:${m[2]}` : null;
  }
  if (marketplace === "amazon") {
    const m = href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    return m ? m[1].toUpperCase() : null;
  }
  // Sem regra própria: usa o caminho como referência estável.
  const clean = href.split("?")[0];
  return clean.length > 8 ? clean : null;
}
