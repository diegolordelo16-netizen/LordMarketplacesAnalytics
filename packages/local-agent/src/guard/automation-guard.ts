/**
 * Automation Guard (§17). 10 verificações obrigatórias antes de qualquer operação,
 * e verificação pós-execução com comparação antes/depois e rollback.
 * Nada é executado se uma verificação obrigatória falhar.
 */
import { roleHasPermission, type AccessRole, type Permission } from '@mi/shared';

export const GUARD_CHECKS = [
  'marketplace',
  'account',
  'listing',
  'current_state',
  'user_permission',
  'financial_limits',
  'required_data',
  'platform_rules',
  'authorization',
  'no_conflict',
] as const;
export type GuardCheck = (typeof GUARD_CHECKS)[number];

export const GUARD_CHECK_LABEL: Record<GuardCheck, string> = {
  marketplace: 'Marketplace válido e habilitado',
  account: 'Conta correta e autenticada',
  listing: 'Anúncio existe e pertence à conta',
  current_state: 'Estado atual capturado',
  user_permission: 'Usuário tem permissão para a ação',
  financial_limits: 'Limites financeiros respeitados',
  required_data: 'Dados obrigatórios presentes',
  platform_rules: 'Regras da plataforma respeitadas',
  authorization: 'Autorização explícita registrada',
  no_conflict: 'Sem conflito com outra tarefa/edição',
};

export const GUARD_ACTIONS = [
  'edit_title',
  'edit_description',
  'upload_image',
  'change_price',
  'duplicate_listing',
  'toggle_ads',
  'change_campaign_budget',
  'create_variation',
  'edit_variation',
] as const;
export type GuardAction = (typeof GUARD_ACTIONS)[number];

export interface GuardContext {
  action: GuardAction;
  actorRole: AccessRole;
  marketplace: { id: string; enabled: boolean };
  account: { id: string; marketplace: string; sessionState: string; verified: boolean } | null;
  listing: { id: string; accountId: string; externalId: string; status: string } | null;
  campaign?: {id:string;accountId:string}|null;
  currentState: Record<string, unknown> | null;
  financialLimits: {
    maxPriceChangePct?: number;
    maxDailyAdSpendCents?: number;
    currentPriceCents?: number;
    newPriceCents?: number;
    currentDailyAdSpendCents?: number;
    minMarginPct?: number;
    resultingMarginPct?: number;
    targetDailyBudgetCents?:number;
    maxCampaignDailyBudgetCents?:number;
    minVariationPriceCents?:number;
    maxVariationPriceCents?:number;
    targetVariationPriceCents?:number;
    maxVariationStock?:number;
    targetVariationStock?:number;
    maxVariationPriceChangePct?:number;
  } | null;
  requiredData: { missing: string[] };
  platformRules: { violations: string[] };
  authorization: { approved: boolean; approvedBy?: string; reason?: string };
  conflicts: string[];
}

export interface GuardCheckResult {
  check: GuardCheck;
  ok: boolean;
  detail: string;
}

export interface GuardDecision {
  allowed: boolean;
  checks: GuardCheckResult[];
  blockedReasons: string[];
  requiresApproval: boolean;
}

const ACTION_PERMISSION: Record<GuardAction, Permission> = {
  edit_title: 'edit_listing',
  edit_description: 'edit_listing',
  upload_image: 'edit_listing',
  change_price: 'manage_financial_limits',
  duplicate_listing: 'edit_listing',
  toggle_ads: 'manage_financial_limits',
  change_campaign_budget: 'manage_financial_limits',
  create_variation: 'manage_financial_limits',
  edit_variation: 'manage_financial_limits',
};

/** Verificação financeira: nenhuma mudança pode furar limites ou margem mínima. */
function checkFinancial(ctx: GuardContext): GuardCheckResult {
  const f = ctx.financialLimits;
  const validInt=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
  if(ctx.action==='change_campaign_budget'){
    const cap=f?.maxCampaignDailyBudgetCents,target=f?.targetDailyBudgetCents;
    const ok=validInt(cap)&&validInt(target)&&Number(target)>0&&Number(target)<=Number(cap);
    return {check:'financial_limits',ok,detail:ok?'orçamento por campanha dentro do teto explícito':'orçamento excede teto explícito ou limite não configurado'};
  }
  if(ctx.action==='create_variation'||ctx.action==='edit_variation'){
    const price=f?.targetVariationPriceCents,stock=f?.targetVariationStock,min=f?.minVariationPriceCents,max=f?.maxVariationPriceCents,stockMax=f?.maxVariationStock;
    let ok=[price,stock,min,max,stockMax].every(validInt)&&Number(price)>0&&Number(price)>=Number(min)&&Number(price)<=Number(max)&&Number(stock)<=Number(stockMax);
    if(ctx.action==='edit_variation'){
      const current=f?.currentPriceCents,pct=f?.maxVariationPriceChangePct;
      ok=ok&&validInt(current)&&Number(current)>0&&typeof pct==='number'&&Number.isFinite(pct)&&pct>=0&&Math.abs(Number(price)-Number(current))/Number(current)*100<=pct;
    }
    return {check:'financial_limits',ok,detail:ok?'preço e estoque dentro dos limites explícitos':'preço, estoque ou variação excedem limites explícitos ou não configurados'};
  }
  if (ctx.action === 'change_price') {
    if (!f || typeof f.currentPriceCents !== 'number' || typeof f.newPriceCents !== 'number') {
      return { check: 'financial_limits', ok: false, detail: 'preço atual/novo ausente: mudança de preço bloqueada' };
    }
    if (typeof f.maxPriceChangePct === 'number') {
      const changePct = Math.abs((f.newPriceCents - f.currentPriceCents) / f.currentPriceCents) * 100;
      if (changePct > f.maxPriceChangePct) {
        return {
          check: 'financial_limits',
          ok: false,
          detail: `variação de ${changePct.toFixed(2)}% acima do limite ${f.maxPriceChangePct}%`,
        };
      }
    }
    if (typeof f.minMarginPct === 'number' && typeof f.resultingMarginPct === 'number' && f.resultingMarginPct < f.minMarginPct) {
      return {
        check: 'financial_limits',
        ok: false,
        detail: `margem resultante ${f.resultingMarginPct.toFixed(1)}% abaixo do mínimo ${f.minMarginPct}%`,
      };
    }
  }
  if (ctx.action === 'toggle_ads') {
    if (typeof f?.maxDailyAdSpendCents === 'number' && typeof f.currentDailyAdSpendCents === 'number') {
      if (f.currentDailyAdSpendCents > f.maxDailyAdSpendCents) {
        return {
          check: 'financial_limits',
          ok: false,
          detail: `gasto diário de Ads ${f.currentDailyAdSpendCents} acima do limite ${f.maxDailyAdSpendCents}`,
        };
      }
    }
  }
  return { check: 'financial_limits', ok: true, detail: 'limites financeiros respeitados' };
}

export function evaluateGuard(ctx: GuardContext): GuardDecision {
  const checks: GuardCheckResult[] = [];

  checks.push({
    check: 'marketplace',
    ok: ctx.marketplace.enabled && ctx.marketplace.id.length > 0,
    detail: ctx.marketplace.enabled ? `marketplace ${ctx.marketplace.id}` : `marketplace ${ctx.marketplace.id} desabilitado`,
  });

  checks.push({
    check: 'account',
    ok: !!ctx.account && ctx.account.sessionState === 'AUTHENTICATED' && ctx.account.verified,
    detail: !ctx.account
      ? 'conta não identificada'
      : ctx.account.sessionState !== 'AUTHENTICATED'
        ? `sessão ${ctx.account.sessionState}`
        : ctx.account.verified
          ? 'conta autenticada e verificada'
          : 'identificação de conta não confirmada por humano',
  });

  checks.push({
    check: 'listing',
    ok: ctx.action==='change_campaign_budget'?Boolean(ctx.campaign?.id&&ctx.account&&ctx.campaign.accountId===ctx.account.id):!!ctx.listing && !!ctx.account && ctx.listing.accountId === ctx.account.id && ctx.listing.status !== 'CLOSED',
    detail: ctx.action==='change_campaign_budget'?(ctx.campaign?.id?'campanha '+ctx.campaign.id+' vinculada à conta':'campanha ausente'):!ctx.listing
      ? 'anúncio não encontrado'
      : ctx.listing.accountId !== ctx.account?.id
        ? 'anúncio pertence a outra conta'
        : `anúncio ${ctx.listing.externalId} (${ctx.listing.status})`,
  });

  checks.push({
    check: 'current_state',
    ok: !!ctx.currentState && Object.keys(ctx.currentState).length > 0,
    detail: ctx.currentState ? `estado atual com ${Object.keys(ctx.currentState).length} campos` : 'estado atual não capturado',
  });

  const perm = ACTION_PERMISSION[ctx.action];
  checks.push({
    check: 'user_permission',
    ok: roleHasPermission(ctx.actorRole, perm) && roleHasPermission(ctx.actorRole, 'execute_task'),
    detail: `ação ${ctx.action} requer ${perm}; perfil ${ctx.actorRole}`,
  });

  checks.push(checkFinancial(ctx));

  checks.push({
    check: 'required_data',
    ok: ctx.requiredData.missing.length === 0,
    detail: ctx.requiredData.missing.length === 0 ? 'dados completos' : `faltando: ${ctx.requiredData.missing.join(', ')}`,
  });

  checks.push({
    check: 'platform_rules',
    ok: ctx.platformRules.violations.length === 0,
    detail: ctx.platformRules.violations.length === 0 ? 'sem violações conhecidas' : ctx.platformRules.violations.join('; '),
  });

  checks.push({
    check: 'authorization',
    ok: ctx.authorization.approved,
    detail: ctx.authorization.approved
      ? `autorizado por ${ctx.authorization.approvedBy ?? 'usuário'}`
      : 'sem autorização explícita',
  });

  checks.push({
    check: 'no_conflict',
    ok: ctx.conflicts.length === 0,
    detail: ctx.conflicts.length === 0 ? 'sem conflito' : ctx.conflicts.join('; '),
  });

  const blocked = checks.filter((c) => !c.ok);
  return {
    allowed: blocked.length === 0,
    checks,
    blockedReasons: blocked.map((c) => `${GUARD_CHECK_LABEL[c.check]}: ${c.detail}`),
    requiresApproval: ['change_price','toggle_ads','duplicate_listing','change_campaign_budget','create_variation','edit_variation'].includes(ctx.action),
  };
}

export interface PostExecutionVerification {
  saved: boolean;
  before: string;
  after: string;
  expected: string;
  preservationOk?: boolean;
  messages: string[];
}

/**
 * Confirma que o marketplace salvou a alteração e que o conteúdo esperado está na tela.
 * Nunca declarar sucesso sem essa verificação (§0.5).
 */
export function verifyPostExecution(input: {
  expected: string;
  observed: string;
  before?: string;
  preservationCheck?: (before: string, after: string) => { ok: boolean; messages: string[] };
}): PostExecutionVerification {
  const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  const messages: string[] = [];
  const saved = normalize(input.observed) === normalize(input.expected);
  if (!saved) messages.push('conteúdo na tela difere do esperado após salvar');
  let preservationOk: boolean | undefined;
  if (input.before !== undefined && input.preservationCheck) {
    const p = input.preservationCheck(input.before, input.observed);
    preservationOk = p.ok;
    messages.push(...p.messages);
  }
  return {
    saved,
    before: input.before ?? '',
    after: input.observed,
    expected: input.expected,
    preservationOk,
    messages,
  };
}
