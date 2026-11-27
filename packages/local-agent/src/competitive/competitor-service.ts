/**
 * Serviço de inteligência competitiva assistida (§22 evoluído).
 *
 * Fluxo obrigatório:
 *   1. produto próprio (catálogo ou link)
 *   2. busca assistida nos marketplaces escolhidos
 *   3. sugestões entram como PENDENTE — nunca aprovadas automaticamente
 *   4. revisão humana: aprovar, rejeitar, editar, recategorizar, reanalisar
 *   5. aprovados entram em monitoramento contínuo
 *   6. cada decisão vira feedback explícito e regra aprendida auditável
 *
 * O que este serviço NÃO faz: chamar endpoint privado, raspar sem captura da
 * extensão, ou afirmar que "treinou um modelo". O aprendizado é regra explícita
 * derivada de decisões humanas, com suporte e evidência.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  applyLearning,
  deriveLearningRules,
  scoreSimilarity,
  withLearning,
  type FeedbackSample,
  type LearningRule,
  type ProductFeatures,
} from '@mi/shared';
import { universalCode } from './universal-code';
import type { LocalDatabase } from '../db/database';

const ownProductInput = z.object({
  accountId: z.string().min(1),
  marketplace: z.string().min(1),
  /** Vínculo com anúncio do catálogo, quando existir. */
  listingId: z.string().optional().nullable(),
  externalId: z.string().max(200).optional().nullable(),
  url: z.string().url().max(2048).optional().nullable(),
  title: z.string().min(1).max(2000),
  brand: z.string().max(200).optional().nullable(),
  universalCode: universalCode.optional().nullable(),
  model: z.string().max(200).optional().nullable(),
  category: z.string().max(300).optional().nullable(),
  attributes: z.record(z.string(), z.string()).optional().nullable(),
  variations: z.array(z.string()).optional().nullable(),
  images: z.array(z.string()).optional().nullable(),
  priceCents: z.number().int().nonnegative().optional().nullable(),
});

const candidateInput = z.object({
  marketplace: z.string().min(1),
  externalId: z.string().max(200).optional().nullable(),
  url: z.string().url().max(2048).optional().nullable(),
  title: z.string().min(1).max(2000),
  brand: z.string().max(200).optional().nullable(),
  model: z.string().max(200).optional().nullable(),
  category: z.string().max(300).optional().nullable(),
  attributes: z.record(z.string(), z.string()).optional().nullable(),
  priceCents: z.number().int().nonnegative().optional().nullable(),
  rating: z.number().min(0).max(5).optional().nullable(),
  reviews: z.number().int().nonnegative().optional().nullable(),
  seller: z.string().max(300).optional().nullable(),
  imageHash: z.string().max(200).optional().nullable(),
});

const searchInput = z.object({
  ownProductId: z.string().min(1),
  marketplaces: z.array(z.string().min(1)).min(1),
  /** Candidatos já capturados pela extensão (UI autenticada). */
  candidates: z.array(candidateInput).max(500).default([]),
  /** Fonte dos candidatos: busca assistida ou link informado pelo usuário. */
  discoveryMethod: z.enum(['BUSCA_ASSISTIDA', 'LINK_INFORMADO', 'LISTA_DO_VENDEDOR']).default('BUSCA_ASSISTIDA'),
  sourceClass: z.enum(['A_PRIMARY_UI', 'B_PLATFORM_EXPORT','F_USER_INPUT']).default('A_PRIMARY_UI'),
});

const reviewInput = z.object({
  relationId: z.string().min(1),
  actorUserId: z.string().optional(),
  actorRole: z.enum(['super_admin', 'operador', 'visualizador']).default('operador'),
});

interface OwnProductRow {
  id: string;
  account_id: string;
  listing_id: string | null;
  marketplace: string;
  external_id: string | null;
  url: string | null;
  title: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  attributes_json: string | null;
  variations_json: string | null;
  images_json: string | null;
  price_cents: number | null;
}

interface CandidateRow {
  id: string;
  own_product_id: string;
  marketplace: string;
  external_id: string | null;
  url: string | null;
  title: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  attributes_json: string | null;
  price_cents: number | null;
  rating: number | null;
  reviews: number | null;
  seller: string | null;
  image_hash: string | null;
  source_class: string;
  discovery_method: string;
  first_seen_at: string;
  last_seen_at: string;
}

interface RelationRow {
  id: string;
  own_product_id: string;
  candidate_id: string;
  relation_kind: 'DIRETO' | 'SIMILAR' | 'INDIRETO';
  status: 'PENDENTE' | 'APROVADO' | 'REJEITADO';
  similarity_pct: number;
  rationale_json: string;
  suggested_by: string;
  suggested_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  manual_edits_json: string | null;
  monitoring_state: 'ATIVO' | 'PAUSADO' | 'REMOVIDO';
  last_reanalysis_at: string | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toFeatures(row: OwnProductRow | CandidateRow): ProductFeatures {
  return {
    title: row.title,
    brand: row.brand,
    model: row.model,
    category: row.category,
    attributes: parseJson<Record<string, string>>(row.attributes_json, {}),
    variations: 'variations_json' in row ? parseJson<string[]>(row.variations_json, []) : null,
    priceCents: row.price_cents,
    seller: 'seller' in row ? row.seller : null,
  };
}

export class CompetitorService {
  constructor(private readonly db: LocalDatabase) {}

  // ------------------------------------------------------------ produto próprio

  upsertOwnProduct(raw: unknown): { id: string } {
    const input = ownProductInput.parse(raw);
    const now = new Date().toISOString();
    if(input.listingId&&!this.db.row('SELECT id FROM listings WHERE id=? AND account_id=? AND marketplace=?',input.listingId,input.accountId,input.marketplace)){
      throw Error('anúncio não pertence à loja e ao marketplace');
    }
    const existing = this.db.row<{ id: string }>(
      `SELECT id FROM own_products WHERE account_id=? AND marketplace=? AND title=?
       AND (?=0 OR (brand IS ? AND universal_code IS ?)) ORDER BY updated_at DESC,id DESC LIMIT 1`,
      input.accountId,input.marketplace,input.title,Number(input.universalCode!==undefined),input.brand??null,input.universalCode??null,
    );
    const id = existing?.id ?? randomUUID();
    if (existing) {
      this.db.db
        .prepare(
          `UPDATE own_products SET listing_id = ?, external_id = ?, url = ?, brand = ?, model = ?, category = ?,
           attributes_json = ?, variations_json = ?, images_json = ?, price_cents = ?, universal_code=COALESCE(?,universal_code), updated_at = ? WHERE id = ?`,
        )
        .run(
          input.listingId ?? null,
          input.externalId ?? null,
          input.url ?? null,
          input.brand ?? null,
          input.model ?? null,
          input.category ?? null,
          JSON.stringify(input.attributes ?? {}),
          JSON.stringify(input.variations ?? []),
          JSON.stringify(input.images ?? []),
          input.priceCents ?? null,
          input.universalCode ?? null,
          now,
          id,
        );
      return { id };
    }
    this.db.db
      .prepare(
        `INSERT INTO own_products (id, account_id, listing_id, marketplace, external_id, url, title, brand, model,
          category, attributes_json, variations_json, images_json, price_cents, universal_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.accountId,
        input.listingId ?? null,
        input.marketplace,
        input.externalId ?? null,
        input.url ?? null,
        input.title,
        input.brand ?? null,
        input.model ?? null,
        input.category ?? null,
        JSON.stringify(input.attributes ?? {}),
        JSON.stringify(input.variations ?? []),
        JSON.stringify(input.images ?? []),
        input.priceCents ?? null,
        input.universalCode ?? null,
        now,
        now,
      );
    return { id };
  }

  listOwnProducts(accountId: string): Array<Record<string, unknown>> {
    return this.db.rows<Record<string, unknown>>(
      'SELECT * FROM own_products WHERE account_id = ? ORDER BY updated_at DESC',
      accountId,
    );
  }

  getOwnProduct(id: string): OwnProductRow | undefined {
    return this.db.row<OwnProductRow>('SELECT * FROM own_products WHERE id = ?', id) ?? undefined;
  }

  // ------------------------------------------------------------ busca assistida

  /**
   * Registra candidatos e cria sugestões PENDENTES com justificativa.
   * Idempotente: candidato já conhecido é atualizado e não gera duplicata.
   */
  search(raw: unknown): {
    runId: string;
    candidatesFound: number;
    suggestionsCreated: number;
    pending: number;
    skipped: number;
    notes: string[];
  } {
    const input = searchInput.parse(raw);
    const own = this.getOwnProduct(input.ownProductId);
    if (!own) throw new Error(`produto próprio não encontrado: ${input.ownProductId}`);

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const notes: string[] = [];
    const ownFeatures = toFeatures(own);
    const rules = this.loadLearningRules(own.account_id);

    this.db.db
      .prepare('INSERT INTO competitor_search_runs (id, own_product_id, marketplaces_json, started_at, used_ai) VALUES (?, ?, ?, ?, 0)')
      .run(runId, own.id, JSON.stringify(input.marketplaces), startedAt);

    let created = 0;
    let skipped = 0;

    for (const candidate of input.candidates) {
      if (!input.marketplaces.includes(candidate.marketplace)) {
        skipped += 1;
        continue;
      }
      const candidateId = this.upsertCandidate(own.id, candidate, input.sourceClass, input.discoveryMethod);

      const existing = this.db.row<RelationRow>(
        'SELECT * FROM competitor_relations WHERE own_product_id = ? AND candidate_id = ?',
        own.id,
        candidateId,
      );
      if (existing) {
        // Decisão humana é soberana: não se recria nem se reabre sozinho.
        skipped += 1;
        continue;
      }

      const base = scoreSimilarity(ownFeatures, {
        title: candidate.title,
        brand: candidate.brand ?? null,
        model: candidate.model ?? null,
        category: candidate.category ?? null,
        attributes: candidate.attributes ?? {},
        priceCents: candidate.priceCents ?? null,
        seller: candidate.seller ?? null,
      });
      const adjusted = withLearning(base, applyLearning({ title: candidate.title, brand: candidate.brand, model: candidate.model, category: candidate.category, attributes: candidate.attributes ?? {}, seller: candidate.seller }, base, rules));

      this.db.db
        .prepare(
          `INSERT INTO competitor_relations (id, own_product_id, candidate_id, relation_kind, status, similarity_pct,
            rationale_json, suggested_by, suggested_at, monitoring_state)
           VALUES (?, ?, ?, ?, 'PENDENTE', ?, ?, ?, ?, 'PAUSADO')`,
        )
        .run(
          randomUUID(),
          own.id,
          candidateId,
          adjusted.kind,
          adjusted.similarityPct,
          JSON.stringify({
            summary: adjusted.summary,
            factors: adjusted.factors,
            missing: adjusted.missing,
            learningRules: adjusted.summary.includes('aprendizado'),
          }),
          rules.length > 0 ? 'REGRAS_APRENDIDAS' : 'REGRAS_LOCAIS',
          new Date().toISOString(),
        );
      created += 1;
    }

    if (input.candidates.length === 0) {
      notes.push('nenhum anúncio candidato recebido: a busca depende da captura da extensão nas páginas autenticadas');
    }
    if (rules.length > 0) notes.push(`${rules.length} regra(s) de aprendizado aplicada(s) nesta busca`);

    const pending = this.countByStatus(own.id, 'PENDENTE');

    this.db.db
      .prepare(
        'UPDATE competitor_search_runs SET finished_at = ?, candidates_found = ?, suggestions_created = ?, notes_json = ? WHERE id = ?',
      )
      .run(new Date().toISOString(), input.candidates.length, created, JSON.stringify(notes), runId);

    return { runId, candidatesFound: input.candidates.length, suggestionsCreated: created, pending, skipped, notes };
  }

  private upsertCandidate(
    ownProductId: string,
    candidate: z.infer<typeof candidateInput>,
    sourceClass: string,
    discoveryMethod: string,
  ): string {
    const now = new Date().toISOString();
    const existing = candidate.externalId
      ? this.db.row<CandidateRow>(
          'SELECT * FROM competitor_candidates WHERE own_product_id = ? AND marketplace = ? AND external_id = ?',
          ownProductId,
          candidate.marketplace,
          candidate.externalId,
        )
      : this.db.row<CandidateRow>(
          'SELECT * FROM competitor_candidates WHERE own_product_id = ? AND marketplace = ? AND title = ?',
          ownProductId,
          candidate.marketplace,
          candidate.title,
        );

    if (existing) {
      // Manual evidence must never overwrite a captured candidate or relabel its data.
      if(sourceClass==='F_USER_INPUT'&&existing.source_class!=='F_USER_INPUT')return existing.id;
      const sameSource=sourceClass===existing.source_class;
      this.db.db
        .prepare(
          `UPDATE competitor_candidates SET url = ?, title = ?, brand = ?, model = ?, category = ?, attributes_json = ?,
            price_cents = ?, rating = ?, reviews = ?, seller = ?, image_hash = ?, source_class=?, last_seen_at = ? WHERE id = ?`,
        )
        .run(
          candidate.url ?? (sameSource?existing.url:null),
          candidate.title,
          candidate.brand ?? (sameSource?existing.brand:null),
          candidate.model ?? (sameSource?existing.model:null),
          candidate.category ?? (sameSource?existing.category:null),
          JSON.stringify(candidate.attributes ?? (sameSource?parseJson(existing.attributes_json, {}):{})),
          candidate.priceCents ?? (sameSource?existing.price_cents:null),
          candidate.rating ?? (sameSource?existing.rating:null),
          candidate.reviews ?? (sameSource?existing.reviews:null),
          candidate.seller ?? (sameSource?existing.seller:null),
          candidate.imageHash ?? (sameSource?existing.image_hash:null),
          sourceClass,
          now,
          existing.id,
        );
      return existing.id;
    }

    const id = randomUUID();
    this.db.db
      .prepare(
        `INSERT INTO competitor_candidates (id, own_product_id, marketplace, external_id, url, title, brand, model,
          category, attributes_json, price_cents, rating, reviews, seller, image_hash, source_class, discovery_method,
          first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ownProductId,
        candidate.marketplace,
        candidate.externalId ?? null,
        candidate.url ?? null,
        candidate.title,
        candidate.brand ?? null,
        candidate.model ?? null,
        candidate.category ?? null,
        JSON.stringify(candidate.attributes ?? {}),
        candidate.priceCents ?? null,
        candidate.rating ?? null,
        candidate.reviews ?? null,
        candidate.seller ?? null,
        candidate.imageHash ?? null,
        sourceClass,
        discoveryMethod,
        now,
        now,
      );
    return id;
  }

  // ------------------------------------------------------------ revisão humana

  /** Lista sugestões/relacionamentos com dados do candidato para a tela de revisão. */
  listRelations(input: { ownProductId?: string; status?: 'PENDENTE' | 'APROVADO' | 'REJEITADO'; accountId?: string }): Array<Record<string, unknown>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.ownProductId) {
      where.push('r.own_product_id = ?');
      params.push(input.ownProductId);
    }
    if (input.accountId) {
      where.push('o.account_id = ?');
      params.push(input.accountId);
    }
    if (input.status) {
      where.push('r.status = ?');
      params.push(input.status);
    }
    const sql = `SELECT r.id, r.relation_kind, r.status, r.similarity_pct, r.rationale_json, r.suggested_by,
        r.suggested_at, r.reviewed_at, r.rejection_reason, r.monitoring_state, r.manual_edits_json,
        o.title AS own_title, o.marketplace AS own_marketplace, o.price_cents AS own_price_cents,
        c.id AS candidate_id, c.title AS candidate_title, c.marketplace, c.url, c.brand, c.model, c.category,
        c.price_cents, c.rating, c.reviews, c.seller, c.source_class, c.last_seen_at
      FROM competitor_relations r
      JOIN own_products o ON o.id = r.own_product_id
      JOIN competitor_candidates c ON c.id = r.candidate_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.status = 'PENDENTE' DESC, r.similarity_pct DESC, r.suggested_at DESC`;
    return this.db.rows<Record<string, unknown>>(sql, ...params);
  }

  /** Aprova e coloca em monitoramento contínuo. */
  approve(raw: unknown): { ok: true; monitoring: 'ATIVO' } {
    const input = reviewInput.parse(raw);
    const relation = this.requireRelation(input.relationId);
    if (relation.status === 'APROVADO') {
      this.db.db.prepare("UPDATE competitor_relations SET monitoring_state='ATIVO' WHERE id=?").run(relation.id);
      return { ok: true, monitoring: 'ATIVO' };
    }

    const now = new Date().toISOString();
    this.db.db
      .prepare(
        `UPDATE competitor_relations SET status = 'APROVADO', reviewed_by = ?, reviewed_at = ?, monitoring_state = 'ATIVO'
         WHERE id = ?`,
      )
      .run(input.actorUserId ?? input.actorRole, now, input.relationId);

    this.recordFeedback(relation, 'APROVADO', input.actorUserId ?? null, input.actorRole, null, null, null);
    this.rebuildLearningRules(relation.own_product_id);
    return { ok: true, monitoring: 'ATIVO' };
  }

  /** Rejeita com motivo: a decisão alimenta o aprendizado. */
  reject(raw: unknown): { ok: true; rulesUpdated: number } {
    const input = reviewInput.extend({ reason: z.string().max(1000).optional() }).parse(raw);
    const relation = this.requireRelation(input.relationId);
    const now = new Date().toISOString();
    this.db.db
      .prepare(
        `UPDATE competitor_relations SET status = 'REJEITADO', reviewed_by = ?, reviewed_at = ?, rejection_reason = ?,
          monitoring_state = 'PAUSADO' WHERE id = ?`,
      )
      .run(input.actorUserId ?? input.actorRole, now, input.reason ?? null, input.relationId);

    this.recordFeedback(relation, 'REJEITADO', input.actorUserId ?? null, input.actorRole, input.reason ?? null, null, null);
    const rules = this.rebuildLearningRules(relation.own_product_id);
    return { ok: true, rulesUpdated: rules.length };
  }

  /** Edita dados do candidato e/ou o rótulo da relação, registrando a correção. */
  edit(raw: unknown): { ok: true } {
    const input = reviewInput
      .extend({
        title: z.string().min(1).max(2000).optional(),
        brand: z.string().max(200).optional(),
        model: z.string().max(200).optional(),
        category: z.string().max(300).optional(),
        priceCents: z.number().int().nonnegative().optional(),
        relationKind: z.enum(['DIRETO', 'SIMILAR', 'INDIRETO']).optional(),
      })
      .parse(raw);
    const relation = this.requireRelation(input.relationId);
    const candidate = this.db.row<CandidateRow>('SELECT * FROM competitor_candidates WHERE id = ?', relation.candidate_id);
    if (!candidate) throw new Error('anúncio candidato não encontrado');

    const edits: Record<string, unknown> = {};
    if (input.title !== undefined) edits.title = input.title;
    if (input.brand !== undefined) edits.brand = input.brand;
    if (input.model !== undefined) edits.model = input.model;
    if (input.category !== undefined) edits.category = input.category;
    if (input.priceCents !== undefined) edits.priceCents = input.priceCents;
    if (input.relationKind !== undefined) edits.relationKind = input.relationKind;
    if (Object.keys(edits).length === 0) return { ok: true };

    this.db.db
      .prepare(
        `UPDATE competitor_candidates SET title = ?, brand = ?, model = ?, category = ?, price_cents = ? WHERE id = ?`,
      )
      .run(
        input.title ?? candidate.title,
        input.brand ?? candidate.brand,
        input.model ?? candidate.model,
        input.category ?? candidate.category,
        input.priceCents ?? candidate.price_cents,
        candidate.id,
      );
    if (input.relationKind) {
      this.db.db.prepare('UPDATE competitor_relations SET relation_kind = ? WHERE id = ?').run(input.relationKind, relation.id);
    }
    this.db.db
      .prepare('UPDATE competitor_relations SET manual_edits_json = ? WHERE id = ?')
      .run(JSON.stringify(edits), relation.id);

    this.recordFeedback(
      relation,
      input.relationKind ? 'RECATEGORIZADO' : 'EDITADO',
      input.actorUserId ?? null,
      input.actorRole,
      null,
      relation.relation_kind,
      input.relationKind ?? relation.relation_kind,
    );
    this.rebuildLearningRules(relation.own_product_id);
    return { ok: true };
  }

  /** Muda o produto relacionado (troca o candidato da relação). */
  changeCandidate(raw: unknown): { ok: true } {
    const input = reviewInput.extend({ candidateId: z.string().min(1) }).parse(raw);
    const relation = this.requireRelation(input.relationId);
    const candidate = this.db.row<CandidateRow>('SELECT * FROM competitor_candidates WHERE id = ?', input.candidateId);
    if (!candidate || candidate.own_product_id !== relation.own_product_id) throw new Error('candidato não pertence ao mesmo produto');
    if (candidate.id === relation.candidate_id) return { ok: true };
    if (this.db.row('SELECT id FROM competitor_relations WHERE own_product_id=? AND candidate_id=?',relation.own_product_id,candidate.id)) throw new Error('candidato já relacionado');
    if (this.db.row('SELECT id FROM competitor_monitoring_points WHERE relation_id=? LIMIT 1',relation.id)) throw new Error('preserve o histórico: crie uma nova relação para outro candidato');
    this.db.db.prepare("UPDATE competitor_relations SET candidate_id=?,status='PENDENTE',monitoring_state='PAUSADO',reviewed_at=NULL,reviewed_by=NULL WHERE id=?").run(candidate.id,relation.id);
    this.recordFeedback(relation, 'EDITADO', input.actorUserId ?? null, input.actorRole, 'produto relacionado alterado', null, null);
    return { ok: true };
  }

  /** Pede nova análise: recalcula a similaridade e devolve para PENDENTE. */
  reanalyze(raw: unknown): { ok: true; similarityPct: number; kind: string; summary: string } {
    const input = reviewInput.parse(raw);
    const relation = this.requireRelation(input.relationId);
    const own = this.getOwnProduct(relation.own_product_id);
    const candidate = this.db.row<CandidateRow>('SELECT * FROM competitor_candidates WHERE id = ?', relation.candidate_id);
    if (!own || !candidate) throw new Error('dados insuficientes para reanálise');

    const base = scoreSimilarity(toFeatures(own), toFeatures(candidate));
    const adjusted = withLearning(base, applyLearning(toFeatures(candidate), base, this.loadLearningRules(own.account_id)));
    const now = new Date().toISOString();

    this.db.db
      .prepare(
        `UPDATE competitor_relations SET status = 'PENDENTE', similarity_pct = ?, relation_kind = ?, rationale_json = ?,
          last_reanalysis_at = ?, reviewed_at = NULL, monitoring_state = CASE WHEN monitoring_state = 'ATIVO' THEN 'PAUSADO' ELSE monitoring_state END
         WHERE id = ?`,
      )
      .run(
        adjusted.similarityPct,
        adjusted.kind,
        JSON.stringify({ summary: adjusted.summary, factors: adjusted.factors, missing: adjusted.missing }),
        now,
        relation.id,
      );

    this.recordFeedback(relation, 'REANALISADO', input.actorUserId ?? null, input.actorRole, null, null, null);
    return { ok: true, similarityPct: adjusted.similarityPct, kind: adjusted.kind, summary: adjusted.summary };
  }

  /** Pausa, retoma ou remove um concorrente aprovado do monitoramento. */
  setMonitoring(raw: unknown): { ok: true; monitoringState: string } {
    const input = reviewInput.extend({ state: z.enum(['ATIVO', 'PAUSADO', 'REMOVIDO']) }).parse(raw);
    const relation = this.requireRelation(input.relationId);
    if (relation.status !== 'APROVADO') throw new Error('só concorrente aprovado pode entrar em monitoramento');
    this.db.db.prepare('UPDATE competitor_relations SET monitoring_state = ? WHERE id = ?').run(input.state, relation.id);
    return { ok: true, monitoringState: input.state };
  }

  // ------------------------------------------------------------ monitoramento

  /** Registra um ponto de histórico de um concorrente aprovado. */
  recordPoint(raw: unknown): { ok: true } {
    const input = z
      .object({
        relationId: z.string().min(1),
        capturedAt: z.string().datetime().optional(),
        priceCents: z.number().int().nonnegative().optional(),
        position: z.number().int().nonnegative().optional(),
        rating: z.number().min(0).max(5).optional(),
        reviews: z.number().int().nonnegative().optional(),
        stockSignal: z.string().max(80).optional(),
        title: z.string().max(2000).optional(),
        variations: z.array(z.string()).optional(),
        promotions: z.array(z.string()).optional(),
        sourceClass: z.enum(['A_PRIMARY_UI', 'B_PLATFORM_EXPORT']).default('A_PRIMARY_UI'),
      })
      .parse(raw);
    const relation = this.requireRelation(input.relationId);
    if (relation.status !== 'APROVADO' || relation.monitoring_state !== 'ATIVO') throw new Error('monitoramento requer concorrente aprovado e ativo');
    if (input.capturedAt && Date.parse(input.capturedAt)>Date.now()) throw new Error('data da captura no futuro');

    this.db.db
      .prepare(
        `INSERT OR REPLACE INTO competitor_monitoring_points (id, relation_id, captured_at, price_cents, position, rating,
          reviews, stock_signal, title, variations_json, promotions_json, source_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        relation.id,
        input.capturedAt ?? new Date().toISOString(),
        input.priceCents ?? null,
        input.position ?? null,
        input.rating ?? null,
        input.reviews ?? null,
        input.stockSignal ?? null,
        input.title ?? null,
        JSON.stringify(input.variations ?? []),
        JSON.stringify(input.promotions ?? []),
        input.sourceClass,
      );
    return { ok: true };
  }

  /** Histórico individual + comparação com o preço do produto próprio. */
  monitoring(input: { relationId: string; limit?: number }): Record<string, unknown> {
    const relation = this.requireRelation(input.relationId);
    const own = this.getOwnProduct(relation.own_product_id);
    const points = this.db.rows<Record<string, unknown>>(
      'SELECT captured_at, price_cents, position, rating, reviews, stock_signal, title, variations_json, promotions_json, source_class FROM competitor_monitoring_points WHERE relation_id = ? AND captured_at<=? ORDER BY captured_at DESC,rowid DESC LIMIT ?',
      relation.id,
      new Date().toISOString(),
      input.limit ?? 365,
    ).reverse();
    const prices = points.map((p) => p.price_cents).filter((p): p is number => typeof p === 'number');
    return {
      relationId: relation.id,
      status: relation.status,
      monitoringState: relation.monitoring_state,
      ownPriceCents: own?.price_cents ?? null,
      competitorPriceCents: prices.length ? prices[prices.length - 1] : null,
      minPriceCents: prices.length ? Math.min(...prices) : null,
      maxPriceCents: prices.length ? Math.max(...prices) : null,
      points,
      note: points.length === 0 ? 'sem histórico: o monitoramento depende de capturas da extensão' : undefined,
    };
  }

  // ------------------------------------------------------------ indicadores

  countByStatus(ownProductId: string, status: 'PENDENTE' | 'APROVADO' | 'REJEITADO'): number {
    const row = this.db.row<{ n: number }>(
      'SELECT COUNT(*) AS n FROM competitor_relations WHERE own_product_id = ? AND status = ?',
      ownProductId,
      status,
    );
    return row?.n ?? 0;
  }

  /**
   * Precisão das recomendações: proporção de sugestões revisadas que foram aprovadas.
   * Sem revisões, devolve null — nunca zero nem 100% inventado.
   */
  stats(input: { accountId?: string; ownProductId?: string }): Record<string, unknown> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (input.ownProductId) {
      where.push('r.own_product_id = ?');
      params.push(input.ownProductId);
    }
    if (input.accountId) {
      where.push('o.account_id = ?');
      params.push(input.accountId);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const counts = this.db.rows<{ status: string; n: number }>(
      `SELECT r.status, COUNT(*) AS n FROM competitor_relations r JOIN own_products o ON o.id = r.own_product_id ${filter} GROUP BY r.status`,
      ...params,
    );
    const byStatus: Record<string, number> = { PENDENTE: 0, APROVADO: 0, REJEITADO: 0 };
    for (const c of counts) byStatus[c.status] = c.n;

    const reviewed = byStatus.APROVADO! + byStatus.REJEITADO!;
    const precision = reviewed > 0 ? Number(((byStatus.APROVADO! / reviewed) * 100).toFixed(1)) : null;

    const rules = this.db.rows<Record<string, unknown>>(
      `SELECT scope, value, direction, support, counter_support, weight FROM competitor_learning_rules
       WHERE account_id=COALESCE(?,(SELECT account_id FROM own_products WHERE id=?)) ORDER BY weight DESC LIMIT 50`,
      input.accountId ?? null,input.ownProductId ?? null,
    );
    const feedback = this.db.row<{ n: number }>(
      `SELECT COUNT(*) AS n FROM competitor_feedback f JOIN own_products o ON o.id = f.own_product_id ${filter.replace(/r\./g, 'f.')}`,
      ...params,
    );

    return {
      pending: byStatus.PENDENTE,
      approved: byStatus.APROVADO,
      rejected: byStatus.REJEITADO,
      reviewed,
      /** null = ainda não há decisões suficientes para medir. */
      precisionPct: precision,
      precisionNote:
        precision === null
          ? 'precisão não calculada: nenhuma sugestão revisada ainda'
          : `precisão sobre ${reviewed} decisões humanas`,
      feedbackEvents: feedback?.n ?? 0,
      learningRules: rules,
      monitoringActive: this.db.row<{ n: number }>(
        `SELECT COUNT(*) AS n FROM competitor_relations r JOIN own_products o ON o.id = r.own_product_id
         ${filter ? `${filter} AND` : 'WHERE'} r.status = 'APROVADO' AND r.monitoring_state = 'ATIVO'`,
        ...params,
      )?.n ?? 0,
    };
  }

  // ------------------------------------------------------------ aprendizado

  loadLearningRules(accountId: string): LearningRule[] {
    const rows = this.db.rows<{ scope: LearningRule['scope']; value: string; direction: LearningRule['direction']; weight: number }>(
      'SELECT scope, value, direction, weight FROM competitor_learning_rules WHERE account_id = ?',
      accountId,
    );
    return rows;
  }

  /**
   * Recalcula as regras a partir do histórico real de decisões.
   * Só usa feedback efetivamente gravado — nada de "treinou o modelo".
   */
  rebuildLearningRules(ownProductId: string): LearningRule[] {
    const own = this.getOwnProduct(ownProductId);
    if (!own) return [];

    const rows = this.db.rows<{
      decision: string;
      candidate_id: string;
    }>(
      `SELECT f.decision, f.candidate_id FROM competitor_feedback f JOIN own_products o ON o.id=f.own_product_id
       WHERE o.account_id=? AND f.decision IN ('APROVADO','REJEITADO') AND f.id=(SELECT latest.id FROM competitor_feedback latest WHERE latest.own_product_id=f.own_product_id AND latest.candidate_id=f.candidate_id AND latest.decision IN ('APROVADO','REJEITADO') ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1) ORDER BY f.created_at ASC`,
      own.account_id,
    );

    const samples: FeedbackSample[] = [];
    for (const row of rows) {
      const candidate = this.db.row<CandidateRow>('SELECT * FROM competitor_candidates WHERE id = ?', row.candidate_id);
      if (!candidate) continue;
      samples.push({
        decision: row.decision === 'APROVADO' ? 'APROVADO' : 'REJEITADO',
        features: toFeatures(candidate),
      });
    }

    const rules = deriveLearningRules(samples, 2);
    const now = new Date().toISOString();
    this.db.db.prepare('DELETE FROM competitor_learning_rules WHERE account_id = ?').run(own.account_id);
    for (const rule of rules) {
      const support = samples.filter((s) => this.ruleMatches(rule, s.features)).length;
      this.db.db
        .prepare(
          `INSERT INTO competitor_learning_rules (id, account_id, scope, value, direction, support, counter_support, weight, first_learned_at, last_updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), own.account_id, rule.scope, rule.value, rule.direction, support, 0, rule.weight, now, now);
    }
    return rules;
  }

  private ruleMatches(rule: LearningRule, features: ProductFeatures): boolean {
    switch (rule.scope) {
      case 'BRAND':
        return Boolean(features.brand) && features.brand!.toLowerCase() === rule.value;
      case 'CATEGORY':
        return Boolean(features.category) && features.category!.toLowerCase() === rule.value;
      case 'MODEL':
        return Boolean(features.model) && features.model!.toLowerCase() === rule.value;
      case 'SELLER':
        return Boolean(features.seller) && features.seller!.toLowerCase() === rule.value;
      case 'TITLE_TERM':
        return features.title.toLowerCase().includes(rule.value);
      default:
        return false;
    }
  }

  // ------------------------------------------------------------ auxiliares

  private requireRelation(id: string): RelationRow {
    const relation = this.db.row<RelationRow>('SELECT * FROM competitor_relations WHERE id = ?', id);
    if (!relation) throw new Error(`relacionamento não encontrado: ${id}`);
    return relation;
  }

  private recordFeedback(
    relation: RelationRow,
    decision: 'APROVADO' | 'REJEITADO' | 'EDITADO' | 'RECATEGORIZADO' | 'REANALISADO',
    actorUserId: string | null,
    actorRole: string,
    reason: string | null,
    fromKind: string | null,
    toKind: string | null,
  ): void {
    const candidate = this.db.row<CandidateRow>('SELECT * FROM competitor_candidates WHERE id = ?', relation.candidate_id);
    if (!candidate) return;
    this.db.db
      .prepare(
        `INSERT INTO competitor_feedback (id, relation_id, own_product_id, candidate_id, decision, from_kind, to_kind,
          from_status, to_status, reason, features_json, actor_user_id, actor_role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        relation.id,
        relation.own_product_id,
        relation.candidate_id,
        decision,
        fromKind,
        toKind,
        relation.status,
        decision === 'APROVADO' ? 'APROVADO' : decision === 'REJEITADO' ? 'REJEITADO' : relation.status,
        reason,
        JSON.stringify(toFeatures(candidate)),
        actorUserId,
        actorRole,
        new Date().toISOString(),
      );
  }
}
