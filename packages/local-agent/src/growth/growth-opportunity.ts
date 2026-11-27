type Metrics = Readonly<Record<string, number | null | undefined>>;
type Baseline = { visits: number; orders: number; gmv: number; rate: number; ticket: number };
type ScenarioKind = 'TRAFFIC' | 'CONVERSION';
const fractions = [0.25, 0.5, 1] as const;

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function money(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100));
}
function baseline(m: Metrics): Baseline | null {
  const { visits, orders, gmv } = m;
  if (!count(visits) || !count(orders) || !money(gmv) || visits < 100 || orders < 10 || orders > visits || gmv <= 0) return null;
  return { visits, orders, gmv, rate: orders / visits, ticket: gmv / orders };
}
export function observedFunnel(m: Metrics, comparable: boolean) {
  const visits = comparable && count(m.visits) ? m.visits : null;
  const orders = comparable && count(m.orders) ? m.orders : null;
  const valid = visits !== null && visits > 0 && orders !== null && orders <= visits;
  return { visits, orders, conversionPct: valid ? orders / visits * 100 : null,
    impressions: null, carts: null, checkout: null, coverage: 'VISITS_AND_ORDERS_ONLY' as const };
}

export function growthOpportunity(current: Metrics, previous: Metrics, comparable: boolean) {
  const funnel = observedFunnel(current, comparable);
  const a = comparable ? baseline(current) : null, b = comparable ? baseline(previous) : null;
  const empty = { funnel, scenarios: [], underused: false, best: null, stockObserved: null };
  if (!a || !b) return { ...empty, status: 'INSUFFICIENT_EVIDENCE' as const };
  const stockObserved = count(current.stockAvailable) ? current.stockAvailable : null;
  const units = count(current.units) && current.units >= a.orders ? current.units : null;
  const unitsPerOrder = units === null ? null : units / a.orders;
  const scenarios: Array<{kind: ScenarioKind; recoveryFraction: number; targetVisits: number; targetConversionPct: number; incrementalOrders: number; incrementalGmvCents: number; stockLimited: boolean}> = [];
  // Each scenario changes just one factor. Alternatives must not be added.
  const generate = (kind: ScenarioKind) => {
    for (const fraction of fractions) {
      const targetVisits = kind === 'TRAFFIC' ? Math.round(a.visits + (b.visits - a.visits) * fraction) : a.visits;
      const targetRate = kind === 'CONVERSION' ? a.rate + (b.rate - a.rate) * fraction : a.rate;
      const desiredOrders = Math.max(0, Math.floor(targetVisits * targetRate - a.orders + 1e-9));
      const stockCapacity = stockObserved === 0 ? 0 : stockObserved !== null && unitsPerOrder !== null ? Math.floor(stockObserved / unitsPerOrder) : null;
      const incrementalOrders = stockCapacity === null ? desiredOrders : Math.min(desiredOrders, stockCapacity);
      const incrementalGmvCents = Math.round(incrementalOrders * a.ticket * 100);
      if (!Number.isSafeInteger(incrementalOrders) || !Number.isSafeInteger(incrementalGmvCents) || incrementalOrders <= 0) continue;
      scenarios.push({kind,recoveryFraction:fraction,targetVisits,targetConversionPct:targetRate*100,incrementalOrders,incrementalGmvCents,stockLimited:stockCapacity!==null&&incrementalOrders<desiredOrders});
    }
  };
  if (b.visits > a.visits) generate('TRAFFIC');
  if (b.rate > a.rate) generate('CONVERSION');
  // A conservative 25% recovery scenario, with observed stock and unit mix, is used for ranking.
  // Stock is historical observation, not proof of present availability; margin remains unverified.
  const best = stockObserved !== null && unitsPerOrder !== null
    ? scenarios.filter(s=>s.recoveryFraction===0.25).sort((x,y)=>y.incrementalGmvCents-x.incrementalGmvCents || x.kind.localeCompare(y.kind))[0] ?? null
    : null;
  return {status: scenarios.length ? 'SCENARIOS_AVAILABLE' as const : 'NO_POSITIVE_SCENARIO' as const, funnel, scenarios,
    underused: stockObserved!==null&&unitsPerOrder!==null&&stockObserved>=unitsPerOrder&&a.visits<=b.visits*0.8&&a.rate>=b.rate,
    best, stockObserved};
}
