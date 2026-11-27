const costs = ['product_cost_cents','packaging_cents','shipping_cents','marketplace_fees_cents','taxes_cents','ad_spend_cents','refunds_cents','return_logistics_cents','cancellation_loss_cents','other_costs_cents'] as const;
type RecordRow = Readonly<Record<string,unknown>>;
function cents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function money(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const n = Math.round(value * 100);
  return cents(n) ? n : null;
}
export function financialOpportunity(records: readonly RecordRow[], scope: {accountId:string;listingId:string;start:string;end:string}, metrics: RecordRow, incrementalGmvCents: number | null) {
  const unavailable = (status: 'NO_RECORD'|'CONFLICT'|'INVALID_RECORD'|'REVENUE_MISMATCH'|'NO_SCENARIO') =>
    ({status,recordId:null,sourceClass:null,profitCents:null,historicalProfitOverGmvPct:null,projectedProfitBeforeExtraActionCostCents:null});
  if (records.length === 0) return unavailable('NO_RECORD');
  if (records.length !== 1) return unavailable('CONFLICT');
  const row = records[0]!;
  if (row.account_id !== scope.accountId || row.listing_id !== scope.listingId ||
      row.period_start !== scope.start || row.period_end !== scope.end) return unavailable('CONFLICT');
  const source = row.source_class;
  const net = row.net_revenue_cents;
  let confirmed = false;
  try { confirmed = JSON.parse(String(row.evidence_json)).costFieldsConfirmed === true; } catch { /* invalid evidence */ }
  if (typeof row.id !== 'string' || !row.id || (source!=='A_PRIMARY_UI'&&source!=='B_PLATFORM_EXPORT'&&source!=='F_USER_INPUT') ||
      !confirmed || !cents(net) || costs.some(k=>!cents(row[k]))) return unavailable('INVALID_RECORD');
  const gmv = money(metrics.gmv), observedNet = money(metrics.netRevenue);
  if (gmv===null || gmv<=0 || observedNet===null || observedNet!==net || net>gmv) return unavailable('REVENUE_MISMATCH');
  const totalCosts = costs.reduce((sum,k)=>sum+Number(row[k]),0);
  const profitCents = net-totalCosts;
  if (!cents(totalCosts)||!Number.isSafeInteger(profitCents)) return unavailable('INVALID_RECORD');
  if (incrementalGmvCents===null||!cents(incrementalGmvCents)||incrementalGmvCents===0) return unavailable('NO_SCENARIO');
  const ratio = profitCents/gmv;
  const projected = Math.round(incrementalGmvCents*ratio);
  if (!Number.isSafeInteger(projected)) return unavailable('INVALID_RECORD');
  return {status:'HISTORICAL_SCENARIO' as const,recordId:row.id,sourceClass:source,profitCents,
    historicalProfitOverGmvPct:ratio*100,projectedProfitBeforeExtraActionCostCents:projected};
}
