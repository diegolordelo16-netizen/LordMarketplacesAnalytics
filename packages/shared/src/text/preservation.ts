/**
 * Preservação integral de descrição (§13.2, §14).
 * Regra absoluta: nenhuma edição pode apagar, resumir ou reescrever o texto original.
 * Este módulo produz o diff auditável e valida a preservação antes de salvar.
 */

export interface PreservationCheck {
  ok: boolean;
  /** Trechos do original que não aparecem no resultado. */
  missingChunks: string[];
  /** Semelhança textual 0..1 (Jaccard sobre trigramas normalizados). */
  similarity: number;
  originalChars: number;
  resultChars: number;
  addedChars: number;
  messages: string[];
}

/** Normaliza apenas para comparação: não altera o texto salvo. */
export function normalizeForComparison(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function trigrams(text: string): Set<string> {
  const t = normalizeForComparison(text).toLowerCase().replace(/\s+/g, ' ');
  const set = new Set<string>();
  for (let i = 0; i <= t.length - 3; i += 1) set.add(t.slice(i, i + 3));
  return set;
}

export function jaccardSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Verifica preservação: cada linha/parágrafo não vazio do original precisa aparecer
 * no resultado (comparação normalizada). Aceita reordenação apenas se `allowReorder`.
 * Semelhança textual é métrica de apoio: o critério de aprovação é a presença integral
 * de todos os trechos originais (o acréscimo sempre reduz o Jaccard em textos curtos).
 */
export function checkPreservation(
  original: string,
  result: string,
  opts: { allowReorder?: boolean; minSimilarity?: number } = {},
): PreservationCheck {
  const minSimilarity = opts.minSimilarity ?? 0.98;
  const originalNorm = normalizeForComparison(original);
  const resultNorm = normalizeForComparison(result);
  const messages: string[] = [];

  const chunks = originalNorm
    .split(/\n+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const missingChunks: string[] = [];
  for (const chunk of chunks) {
    if (resultNorm.includes(chunk)) continue;
    // Se reordenação permitida, checa presença de todas as palavras do trecho.
    if (opts.allowReorder) {
      const words = chunk.split(/\s+/).filter((w) => w.length > 2);
      const resultWords = new Set(resultNorm.split(/\s+/));
      const allPresent = words.every((w) => resultWords.has(w));
      if (allPresent) continue;
    }
    missingChunks.push(chunk.slice(0, 200));
  }

  const similarity = jaccardSimilarity(originalNorm, resultNorm);
  // Aprovação exige todos os trechos originais presentes E resultado contendo o original inteiro.
  const ok = missingChunks.length === 0 && resultNorm.includes(originalNorm);

  if (missingChunks.length > 0) messages.push(`${missingChunks.length} trecho(s) do texto original não estão no resultado`);
  if (similarity < minSimilarity) messages.push(`similaridade ${(similarity * 100).toFixed(1)}% abaixo do mínimo ${(minSimilarity * 100).toFixed(0)}%`);

  return {
    ok,
    missingChunks,
    similarity: Math.round(similarity * 1000) / 1000,
    originalChars: original.length,
    resultChars: result.length,
    addedChars: Math.max(0, result.length - original.length),
    messages,
  };
}

/** Diff por linhas (LCS) para trilha de auditoria. */
export interface DiffLine {
  type: 'same' | 'added' | 'removed';
  text: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  // LCS clássico — descrições têm dezenas de linhas, custo desprezível.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = dp[i] as number[];
      const next = dp[i + 1] as number[];
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] as string });
      i += 1;
      j += 1;
    } else if ((dp[i + 1] as number[])[j]! >= (dp[i] as number[])[j + 1]!) {
      out.push({ type: 'removed', text: a[i] as string });
      i += 1;
    } else {
      out.push({ type: 'added', text: b[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: 'removed', text: a[i] as string });
    i += 1;
  }
  while (j < m) {
    out.push({ type: 'added', text: b[j] as string });
    j += 1;
  }
  return out;
}

export interface AntiReturnBlockInput {
  category: string;
  knownSpecs: Record<string, string>;
  pendingSpecs: string[];
  returnReasons?: string[];
  storePolicy?: string;
}

/**
 * Gera blocos preventivos de troca/devolução SEM IA, a partir de dados confirmados.
 * Nunca inventa especificação: o que não é conhecido entra como "informação a confirmar".
 */
export function buildAntiReturnBlocks(input: AntiReturnBlockInput): string {
  const lines: string[] = [];
  const specEntries = Object.entries(input.knownSpecs).filter(([, v]) => v.trim().length > 0);
  if (specEntries.length > 0) {
    lines.push('INFORMAÇÕES IMPORTANTES ANTES DA COMPRA');
    for (const [k, v] of specEntries) lines.push(`• ${k}: ${v}`);
  }
  if (input.returnReasons && input.returnReasons.length > 0) {
    lines.push('');
    lines.push('PARA EVITAR TROCAS E DEVOLUÇÕES');
    for (const r of input.returnReasons) lines.push(`• ${r}`);
  }
  if (input.storePolicy && input.storePolicy.trim()) {
    lines.push('');
    lines.push('POLÍTICA DA LOJA');
    lines.push(input.storePolicy.trim());
  }
  if (input.pendingSpecs.length > 0) {
    lines.push('');
    lines.push(`Itens pendentes de confirmação do fabricante: ${input.pendingSpecs.join(', ')}.`);
  }
  return lines.join('\n').trim();
}

/**
 * Compõe descrição final: original INTACTO + bloco adicional.
 * `position` controla onde o bloco entra, sem nunca remover o original.
 */
export function composeDescription(
  original: string,
  addition: string,
  position: 'top' | 'bottom' = 'bottom',
): string {
  const add = addition.trim();
  if (!add) return original;
  if (original.includes(add)) return original; // idempotente
  const sep = original.trim().length > 0 ? '\n\n' : '';
  return position === 'top' ? `${add}${sep}${original}` : `${original}${sep}${add}`;
}

/** Monta o prompt de enriquecimento garantindo que o modelo devolva só o acréscimo. */
export function buildAdditionOnlyPrompt(params: {
  originalDescription: string;
  productFacts: Record<string, string>;
  criticalTopics: string[];
  maxChars: number;
}): string {
  return [
    'Você é um especialista em CRO de anúncios de marketplace e prevenção de devoluções.',
    'TAREFA: escrever APENAS o bloco adicional que será anexado à descrição existente.',
    'REGRAS INVIOLÁVEIS:',
    '1. NÃO reescreva, resuma, corrija ou repita a descrição original.',
    '2. NÃO invente especificações, medidas, materiais ou certificações que não estejam nos FATOS CONFIRMADOS.',
    '3. Se um dado importante faltar, escreva-o como pendência de confirmação, nunca como fato.',
    '4. Responda somente com o texto do bloco, sem preâmbulo, sem markdown de código.',
    `5. Máximo de ${params.maxChars} caracteres.`,
    '',
    'FATOS CONFIRMADOS:',
    ...Object.entries(params.productFacts).map(([k, v]) => `- ${k}: ${v}`),
    '',
    `TÓPICOS CRÍTICOS (lacunas de troca/devolução): ${params.criticalTopics.join(', ')}`,
    '',
    'DESCRIÇÃO ORIGINAL (somente para contexto — não reproduzir):',
    '<<<INICIO>>>',
    params.originalDescription,
    '<<<FIM>>>',
  ].join('\n');
}
