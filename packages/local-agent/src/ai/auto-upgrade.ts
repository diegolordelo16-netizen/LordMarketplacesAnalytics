/**
 * Motor de Auto-Upgrade governado (§18.3).
 * Travamentos obrigatórios: nada é aplicado sem validação + testes + aprovação do super_admin
 * + backup automático, e cada aplicação é reversível com 1 clique.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { LocalDatabase } from '../db/database';
import type { GeminiClient } from '../ai/gemini-client';
import { scanUntrustedText, wrapUntrustedData } from '@mi/shared';

export type ProposalStatus = 'PROPOSTO' | 'TESTANDO' | 'APROVADO' | 'APLICADO' | 'REJEITADO' | 'REVERTIDO';
export type UpgradeRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface UpgradeProposal {
  id: string;
  createdAt: string;
  module: string;
  diagnosis: string;
  diffText: string;
  risk: UpgradeRisk;
  status: ProposalStatus;
  tests: { command: string; passed: boolean; output: string }[];
}

export interface ApplyPreconditions {
  proposalId: string;
  superAdminApproved: boolean;
  approverRole: string;
  testsPassed: boolean;
  syntaxValid: boolean;
  backupPath: string;
}

/** Decide se o patch pode ser aplicado. Devolve TODAS as razões de bloqueio. */
export function canApply(pre: ApplyPreconditions): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (pre.approverRole !== 'super_admin') reasons.push('apenas super_admin pode aprovar auto-upgrade');
  if (!pre.superAdminApproved) reasons.push('sem aprovação explícita do super_admin');
  if (!pre.testsPassed) reasons.push('suíte de testes relevante não passou');
  if (!pre.syntaxValid) reasons.push('patch com erro de sintaxe/schema');
  if (!pre.backupPath || !existsSync(pre.backupPath)) reasons.push('backup pré-aplicação ausente ou inválido');
  return { allowed: reasons.length === 0, reasons };
}

/** Recusa caminhos absolutos, traversal e sintaxe de caminho Windows em qualquer host. */
function assertSafePatchPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => part === '..')
  ) {
    throw new Error(`caminho de patch fora da raiz permitido: ${rawPath}`);
  }
  const segments = normalized.split('/').filter((part) => part && part !== '.');
  if (segments.length === 0) throw new Error(`caminho de patch inválido: ${rawPath}`);
  return segments.join(sep);
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve sob a raiz e verifica o ancestral real existente para bloquear symlink escape. */
function resolveInsideRoot(root: string, rawPath: string): string {
  const safePath = assertSafePatchPath(rawPath);
  const rootPath = realpathSync(resolve(root));
  const target = resolve(rootPath, safePath);
  if (!isPathInside(rootPath, target)) {
    throw new Error(`caminho de patch fora da raiz permitido: ${rawPath}`);
  }
  let current = target;
  while (isPathInside(rootPath, current)) {
    if (existsSync(current)) {
      const actual = realpathSync(current);
      if (!isPathInside(rootPath, actual)) {
        throw new Error(`caminho de patch atravessa link simbólico fora da raiz: ${rawPath}`);
      }
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return target;
}

export interface PatchPreview {
  files: Array<{ path: string; addedLines: number; removedLines: number; risk: UpgradeRisk }>;
  summary: string;
  touchesCritical: string[];
}

const CRITICAL_PATH_HINTS = ['guard', 'secrets', 'automation', 'permissions', 'auth', 'scheduler'];

/** Analisa o diff textual e classifica risco sem confiar em nada do modelo. */
export function analyzePatch(diffText: string): PatchPreview {
  const files: PatchPreview['files'] = [];
  const blocks = diffText.split(/^(?=diff --git |--- )/m).filter((b) => b.trim().length > 0);
  const touchesCritical: string[] = [];
  for (const block of blocks) {
    const pathMatch = /(?:diff --git a\/(\S+)|\+\+\+ b\/(\S+)|^--- a\/(\S+))/m.exec(block);
    const path = pathMatch?.[1] ?? pathMatch?.[2] ?? pathMatch?.[3] ?? 'desconhecido';
    const added = block.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = block.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    const lower = path.toLowerCase();
    const critical = CRITICAL_PATH_HINTS.some((h) => lower.includes(h));
    if (critical) touchesCritical.push(path);
    const risk: UpgradeRisk = critical ? 'CRITICAL' : added + removed > 200 ? 'HIGH' : added + removed > 50 ? 'MEDIUM' : 'LOW';
    files.push({ path, addedLines: added, removedLines: removed, risk });
  }
  const summary = `${files.length} arquivo(s), ${files.reduce((a, f) => a + f.addedLines, 0)} linhas adicionadas, ${files.reduce((a, f) => a + f.removedLines, 0)} removidas`;
  return { files, summary, touchesCritical };
}

export class AutoUpgradeEngine {
  constructor(
    private readonly db: LocalDatabase,
    private readonly gemini: GeminiClient,
    private readonly baseDir: string,
  ) {}

  /** Pede ao Gemini um patch para um adapter quebrado. Resultado é SEMPRE uma proposta, nunca aplicação. */
  async proposeAdapterFix(input: {
    module: string;
    symptoms: string;
    currentCode: string;
    testCommand: string;
  }): Promise<{ ok: boolean; proposalId?: string; message: string }> {
    const scan = scanUntrustedText(input.symptoms);
    const prompt = [
      'Você propõe patches para um adapter de marketplace que quebrou.',
      'Responda APENAS com um diff unificado (formato git) e nada mais.',
      'Regras: não alterar verificações de segurança, não adicionar rede além do necessário, manter tipos.',
      wrapUntrustedData('sintomas_observados', input.symptoms, scan),
      'CÓDIGO ATUAL:',
      '<<<DADOS>>>',
      input.currentCode.slice(0, 40_000),
      '<<<FIM_DADOS>>>',
    ].join('\n');

    const res = await this.gemini.call({
      agentKey: 'system.autoupgrade',
      model: 'gemini-2.5-pro',
      systemPrompt: 'Você é um engenheiro sênior. Sua saída é revisada por humanos antes de qualquer aplicação.',
      userContent: prompt,
      temperature: 0.1,
    });
    if (!res.ok) return { ok: false, message: res.message };

    const preview = analyzePatch(res.text);
    const id = randomUUID();
    this.db.db
      .prepare(
        `INSERT INTO auto_upgrade_proposals (id, created_at, module, diagnosis, diff_text, risk, tests_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PROPOSTO')`,
      )
      .run(
        id,
        new Date().toISOString(),
        input.module,
        `diagnóstico via Gemini (${preview.summary}); arquivos críticos: ${preview.touchesCritical.join(', ') || 'nenhum'}`,
        res.text,
        preview.touchesCritical.length > 0 ? 'CRITICAL' : preview.files[0]?.risk ?? 'MEDIUM',
        JSON.stringify([{ command: input.testCommand, passed: false, output: 'não executado' }]),
      );
    return { ok: true, proposalId: id, message: `proposta ${id} criada; aguardando testes e aprovação` };
  }

  list(): Array<{ id: string; module: string; risk: UpgradeRisk; status: ProposalStatus; created_at: string }> {
    return this.db.rows<{ id: string; module: string; risk: UpgradeRisk; status: ProposalStatus; created_at: string }>(
      'SELECT id, module, risk, status, created_at FROM auto_upgrade_proposals ORDER BY created_at DESC',
    );
  }

  /** Grava o patch em área de staging, roda testes e registra o resultado real. */
  async stageAndTest(
    proposalId: string,
    runner: (diff: string) => Promise<{ passed: boolean; output: string }>,
  ): Promise<{ passed: boolean; output: string; stagingPath: string }> {
    const row = this.db.db
      .prepare('SELECT diff_text, module FROM auto_upgrade_proposals WHERE id = ?')
      .get(proposalId) as { diff_text: string; module: string } | undefined;
    if (!row) throw new Error(`proposta inexistente: ${proposalId}`);

    const stagingDir = join(this.baseDir, 'staging', proposalId);
    mkdirSync(stagingDir, { recursive: true });
    const stagingPath = join(stagingDir, 'proposal.diff');
    writeFileSync(stagingPath, row.diff_text, 'utf8');

    this.db.db.prepare("UPDATE auto_upgrade_proposals SET status = 'TESTANDO' WHERE id = ?").run(proposalId);
    const result = await runner(row.diff_text);
    const tests = [{ command: 'vitest (módulo afetado)', passed: result.passed, output: result.output.slice(0, 4000) }];
    this.db.db
      .prepare('UPDATE auto_upgrade_proposals SET tests_json = ? WHERE id = ?')
      .run(JSON.stringify(tests), proposalId);
    return { passed: result.passed, output: result.output, stagingPath };
  }

  /**
   * Aplica o patch. Exige todas as precondições; cria backup do banco e snapshot dos
   * arquivos alvo antes de tocar em qualquer coisa.
   */
  apply(input: {
    proposalId: string;
    approverRole: string;
    superAdminApproved: boolean;
    targetRoot: string;
    readFile: (relativePath: string) => string | null;
    writeFile: (relativePath: string, content: string) => void;
  }): { applied: boolean; backupPath?: string; reasons: string[] } {
    const row = this.db.db
      .prepare('SELECT * FROM auto_upgrade_proposals WHERE id = ?')
      .get(input.proposalId) as
      | { id: string; diff_text: string; tests_json: string; risk: UpgradeRisk; status: ProposalStatus; module: string }
      | undefined;
    if (!row) return { applied: false, reasons: ['proposta inexistente'] };

    const tests = JSON.parse(row.tests_json ?? '[]') as Array<{ passed: boolean }>;
    const testsPassed = tests.length > 0 && tests.every((t) => t.passed);
    const syntaxValid = validatePatchSyntax(row.diff_text);

    // Backup obrigatório antes de checar o resto (para que a decisão seja auditável).
    const backup = this.db.backup(`pré-aplicação auto-upgrade ${row.id}`);
    const pre = canApply({
      proposalId: row.id,
      superAdminApproved: input.superAdminApproved,
      approverRole: input.approverRole,
      testsPassed,
      syntaxValid,
      backupPath: backup.path,
    });
    if (!pre.allowed) {
      return { applied: false, reasons: pre.reasons };
    }

    // Snapshot dos arquivos alvo.
    const snapshotDir = join(this.baseDir, 'upgrade-snapshots', row.id);
    mkdirSync(snapshotDir, { recursive: true });
    let targets: string[];
    try {
      targets = extractTargetPaths(row.diff_text);
    } catch (err) {
      return { applied: false, reasons: [err instanceof Error ? err.message : String(err)], backupPath: backup.path };
    }
    try {
      for (const t of targets) {
        const abs = resolveInsideRoot(input.targetRoot, t);
        if (existsSync(abs)) {
          const dest = join(snapshotDir, t.replace(/[\\/]/g, '__'));
          copyFileSync(abs, dest);
        }
      }
    } catch (err) {
      return { applied: false, reasons: [err instanceof Error ? err.message : String(err)], backupPath: backup.path };
    }

    const { appliedFiles, errors } = applyUnifiedDiff(row.diff_text, input.readFile, input.writeFile);
    if (errors.length > 0) {
      return { applied: false, reasons: [`patch não aplicado: ${errors.join('; ')}`], backupPath: backup.path };
    }

    this.db.db
      .prepare("UPDATE auto_upgrade_proposals SET status = 'APLICADO', approved_by = ?, applied_at = ?, backup_path = ? WHERE id = ?")
      .run(input.approverRole, new Date().toISOString(), backup.path, row.id);
    this.audit(row.id, 'APPLY', `arquivos: ${appliedFiles.join(', ')}; backup ${backup.path}`);
    return { applied: true, backupPath: backup.path, reasons: [] };
  }

  /** Rollback em 1 clique: restaura o backup e marca a proposta como revertida. */
  rollback(proposalId: string, targetRoot: string, readFile: (rel: string) => string | null, writeFile: (rel: string, content: string) => void): { ok: boolean; message: string } {
    const row = this.db.db
      .prepare('SELECT id, diff_text FROM auto_upgrade_proposals WHERE id = ?')
      .get(proposalId) as { id: string; diff_text: string } | undefined;
    if (!row) return { ok: false, message: 'proposta inexistente' };
    const snapshotDir = join(this.baseDir, 'upgrade-snapshots', proposalId);
    if (!existsSync(snapshotDir)) return { ok: false, message: 'snapshot de arquivos não encontrado' };

    let targets: string[];
    try {
      targets = extractTargetPaths(row.diff_text).map((path) => {
        resolveInsideRoot(targetRoot, path);
        return path;
      });
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    let restored = 0;
    for (const t of targets) {
      const snap = join(snapshotDir, t.replace(/[\\/]/g, '__'));
      if (existsSync(snap)) {
        writeFile(t, readFileSync(snap, 'utf8'));
        restored += 1;
      }
    }
    this.db.db
      .prepare("UPDATE auto_upgrade_proposals SET status = 'REVERTIDO', rolled_back_at = ? WHERE id = ?")
      .run(new Date().toISOString(), proposalId);
    this.audit(proposalId, 'ROLLBACK', `${restored} arquivo(s) restaurados em ${targetRoot}`);
    return { ok: true, message: `${restored} arquivo(s) restaurados do snapshot` };
  }

  private audit(entityId: string, action: string, reason: string): void {
    this.db.db
      .prepare(
        'INSERT INTO audit_log (at, action, entity, entity_id, result, reason) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(new Date().toISOString(), action, 'auto_upgrade_proposal', entityId, 'OK', reason);
  }
}

/** Validação mínima de sintaxe do diff (não executa código). */
export function validatePatchSyntax(diff: string): boolean {
  if (!diff.includes('---') || !diff.includes('+++')) return false;
  const hunks = diff.split('\n').filter((l) => l.startsWith('@@'));
  if (hunks.length === 0) return false;
  for (const h of hunks) {
    if (!/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(h)) return false;
  }
  // Nunca aceitar patch que altere verificação de segurança.
  const forbidden = [/^\+.*disableGuard/i, /^\+.*skipAuth/i, /^\+.*allowAll/i, /^\+.*process\.env\.NODE_TLS_REJECT_UNAUTHORIZED/i];
  for (const f of forbidden) if (f.test(diff)) return false;
  return true;
}

export function extractTargetPaths(diff: string): string[] {
  const paths = new Set<string>();
  const re = /^\+\+\+ b\/(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    const p = (m[1] as string).trim();
    if (p && p !== '/dev/null') paths.add(assertSafePatchPath(p));
  }
  return [...paths];
}

/**
 * Aplicador de diff unificado por hunks exatos. Falha (em vez de adivinhar) quando o
 * contexto não bate — um patch aplicado errado em produção é pior que um patch recusado.
 * `reader` fornece o conteúdo atual de cada arquivo; nunca lê do disco por conta própria.
 */
export function applyUnifiedDiff(
  diff: string,
  reader: (rel: string) => string | null,
  writeFile: (rel: string, content: string) => void,
): { appliedFiles: string[]; errors: string[] } {
  const errors: string[] = [];
  const appliedFiles: string[] = [];
  const pendingWrites: Array<{ target: string; original: string; content: string }> = [];
  const fileBlocks = diff.split(/^diff --git /m).slice(1);
  const blocks = fileBlocks.length > 0 ? fileBlocks : [diff];

  for (const block of blocks) {
    const targetMatch = /^\+\+\+ b\/(.+)$/m.exec(block);
    const sourceMatch = /^--- a\/(.+)$/m.exec(block);
    const rawTarget = targetMatch?.[1]?.trim();
    if (!rawTarget) continue;
    let target: string;
    let source: string;
    try {
      target = assertSafePatchPath(rawTarget);
      source = assertSafePatchPath(sourceMatch?.[1]?.trim() ?? rawTarget);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    const hunks = block.split(/^(?=@@ )/m).filter((h) => h.startsWith('@@'));
    const baseContent = reader(source);
    if (baseContent === null) {
      errors.push(`arquivo base não encontrado: ${source}`);
      continue;
    }
    let content: string = baseContent;
    let ok = true;
    for (const hunk of hunks) {
      const lines = hunk.split('\n');
      const header = lines[0] as string;
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
      if (!hm) {
        ok = false;
        errors.push(`hunk inválido: ${header}`);
        break;
      }
      const oldStart = Number.parseInt(hm[1] as string, 10) - 1;
      const body = lines.slice(1).filter((l) => l.length > 0 && !l.startsWith('\\'));
      const oldLines = body.filter((l) => l.startsWith(' ') || l.startsWith('-')).map((l) => l.slice(1));
      const newLines = body.filter((l) => l.startsWith(' ') || l.startsWith('+')).map((l) => l.slice(1));
      const current: string[] = content.split('\n');
      const slice = current.slice(oldStart, oldStart + oldLines.length);
      if (slice.join('\n') !== oldLines.join('\n')) {
        ok = false;
        errors.push(`contexto do hunk não corresponde em ${target}:${oldStart + 1}`);
        break;
      }
      current.splice(oldStart, oldLines.length, ...newLines);
      content = current.join('\n');
    }
    if (ok) pendingWrites.push({ target, original: baseContent, content });
  }

  if (errors.length === 0) {
    const committed: typeof pendingWrites = [];
    try {
      for (const item of pendingWrites) {
        committed.push(item);
        writeFile(item.target, item.content);
        appliedFiles.push(item.target);
      }
    } catch (err) {
      for (const item of committed.reverse()) {
        try {
          writeFile(item.target, item.original);
        } catch (rollbackError) {
          errors.push(`rollback de ${item.target} falhou: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      appliedFiles.length = 0;
      errors.unshift(`falha ao gravar arquivos do patch: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { appliedFiles, errors };
}

export function diffChecksum(diff: string): string {
  return createHash('sha256').update(diff).digest('hex').slice(0, 16);
}
