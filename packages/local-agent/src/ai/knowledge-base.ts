/**
 * Memória operacional local + RAG leve (§29.1).
 * Não há "treinamento de modelo": há banco de conhecimento estruturado, recuperação por
 * similaridade léxica (TF-IDF/BM25 simplificado) e regras validadas por uso.
 */
import type { LocalDatabase } from '../db/database';
import { randomUUID } from 'node:crypto';

export interface KnowledgeItem {
  id: string;
  scope: string;
  marketplace: string | null;
  account_id: string | null;
  category: string | null;
  title: string;
  content: string;
  tags_json: string | null;
  source: string;
  confidence: number;
  validations: number;
  created_at: string;
  updated_at: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export interface RetrievalHit {
  item: KnowledgeItem;
  score: number;
  matchedTerms: string[];
}

export class KnowledgeBase {
  constructor(private readonly db: LocalDatabase) {}

  add(input: {
    scope: string;
    title: string;
    content: string;
    source: string;
    confidence: number;
    marketplace?: string;
    accountId?: string;
    category?: string;
    tags?: string[];
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.db
      .prepare(
        `INSERT INTO knowledge_items (id, scope, marketplace, account_id, category, title, content, tags_json, source, confidence, validations, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.scope,
        input.marketplace ?? null,
        input.accountId ?? null,
        input.category ?? null,
        input.title,
        input.content,
        input.tags ? JSON.stringify(input.tags) : null,
        input.source,
        input.confidence,
        now,
        now,
      );
    return id;
  }

  list(scope?: string): KnowledgeItem[] {
    return scope
      ? (this.db.rows<KnowledgeItem>('SELECT * FROM knowledge_items WHERE scope = ? ORDER BY updated_at DESC', scope))
      : (this.db.rows<KnowledgeItem>('SELECT * FROM knowledge_items ORDER BY updated_at DESC'));
  }

  /** Recuperação BM25 simplificada sobre título+conteúdo+tags. */
  search(query: string, opts: { scope?: string; marketplace?: string; category?: string; limit?: number } = {}): RetrievalHit[] {
    const limit = opts.limit ?? 5;
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const rows = this.db.rows<KnowledgeItem>('SELECT * FROM knowledge_items');
    const filtered = rows.filter(
      (r) =>
        (!opts.scope || r.scope === opts.scope) &&
        (!opts.marketplace || r.marketplace === null || r.marketplace === opts.marketplace) &&
        (!opts.category || r.category === null || r.category === opts.category),
    );
    if (filtered.length === 0) return [];

    const docs = filtered.map((r) => ({ item: r, tokens: tokenize(`${r.title} ${r.content} ${r.tags_json ?? ''}`) }));
    const N = docs.length;
    const avgLen = docs.reduce((a, d) => a + d.tokens.length, 0) / N;
    const k1 = 1.5;
    const b = 0.75;

    const hits: RetrievalHit[] = [];
    for (const doc of docs) {
      const tf = new Map<string, number>();
      for (const t of doc.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      const matched: string[] = [];
      for (const term of terms) {
        const f = tf.get(term) ?? 0;
        if (f === 0) continue;
        matched.push(term);
        const df = docs.filter((d) => d.tokens.includes(term)).length;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const denom = f + k1 * (1 - b + (b * doc.tokens.length) / avgLen);
        score += idf * ((f * (k1 + 1)) / denom);
      }
      if (score > 0) {
        // Confiança do item entra como multiplicador suave.
        hits.push({ item: doc.item, score: Math.round(score * (0.5 + doc.item.confidence * 0.5) * 1000) / 1000, matchedTerms: matched });
      }
    }
    return hits.sort((a, b2) => b2.score - a.score).slice(0, limit);
  }

  /** Registra validação (feedback humano ou auditoria) e promove confiança. */
  validate(id: string, success: boolean): void {
    const row = this.db.db.prepare('SELECT confidence, validations FROM knowledge_items WHERE id = ?').get(id) as
      | { confidence: number; validations: number }
      | undefined;
    if (!row) throw new Error(`item de conhecimento inexistente: ${id}`);
    const validations = row.validations + 1;
    const confidence = Math.min(0.99, (row.confidence * row.validations + (success ? 1 : 0)) / validations);
    this.db.db
      .prepare('UPDATE knowledge_items SET validations = ?, confidence = ?, updated_at = ? WHERE id = ?')
      .run(validations, confidence, new Date().toISOString(), id);
  }

  /** Base anti-devolução por categoria/marketplace (§13.2). */
  recordDescriptionLearning(input: {
    marketplace: string;
    category: string;
    productType?: string;
    pattern: Record<string, unknown>;
    source: 'GEMINI' | 'LOCAL' | 'HUMAN';
    success: boolean;
  }): string {
    const existing = this.db.db
      .prepare(
        'SELECT id, validations, successes FROM description_learnings WHERE marketplace = ? AND category = ? AND COALESCE(product_type, "") = COALESCE(?, "")',
      )
      .get(input.marketplace, input.category, input.productType ?? null) as
      | { id: string; validations: number; successes: number }
      | undefined;

    if (existing) {
      this.db.db
        .prepare('UPDATE description_learnings SET validations = ?, successes = ?, last_validated_at = ?, pattern_json = ? WHERE id = ?')
        .run(
          existing.validations + 1,
          existing.successes + (input.success ? 1 : 0),
          new Date().toISOString(),
          JSON.stringify(input.pattern),
          existing.id,
        );
      return existing.id;
    }
    const id = randomUUID();
    this.db.db
      .prepare(
        `INSERT INTO description_learnings (id, marketplace, category, product_type, pattern_json, validations, successes, last_validated_at, source)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(id, input.marketplace, input.category, input.productType ?? null, JSON.stringify(input.pattern), input.success ? 1 : 0, new Date().toISOString(), input.source);
    return id;
  }

  coverageFor(marketplace: string, category: string): { patternValidations: number; patternSuccessRate: number; lastValidatedAt: string | null } | null {
    const row = this.db.db
      .prepare(
        'SELECT validations, successes, last_validated_at FROM description_learnings WHERE marketplace = ? AND category = ? ORDER BY validations DESC LIMIT 1',
      )
      .get(marketplace, category) as { validations: number; successes: number; last_validated_at: string | null } | undefined;
    if (!row) return null;
    return {
      patternValidations: row.validations,
      patternSuccessRate: row.validations > 0 ? row.successes / row.validations : 0,
      lastValidatedAt: row.last_validated_at,
    };
  }
}
