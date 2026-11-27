type Metrics = Readonly<Record<string, number | null | undefined>>;
type Factors = readonly [number, number, number];
const permutations = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]] as const;

function known(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function factors(m: Metrics): Factors | null {
  const { gmv, orders, visits } = m;
  if (!known(gmv) || !known(orders) || !known(visits) ||
      !Number.isSafeInteger(orders) || !Number.isSafeInteger(visits) ||
      orders <= 0 || visits <= 0 || orders > visits) return null;
  return [visits, orders / visits, gmv / orders];
}

function cents(value: unknown): number | null {
  if (!known(value)) return null;
  const result = Math.round(value * 100);
  return Number.isSafeInteger(result) ? result : null;
}

function revenue(f: readonly number[]): number {
  return (f[0] ?? 0) * (f[1] ?? 0) * (f[2] ?? 0) * 100;
}

export function revenueDrivers(current: Metrics, previous: Metrics, comparable: boolean) {
  const before = cents(previous.gmv), after = cents(current.gmv);
  if (!comparable || before === null || after === null) {
    return { status: 'INSUFFICIENT_EVIDENCE' as const, deltaCents: null, observedDeclineCents: null, drivers: null };
  }
  const deltaCents = after - before;
  const observedDeclineCents = Math.max(0, -deltaCents);
  const a = factors(previous), b = factors(current);
  if (!a || !b) return { status: 'TOTAL_ONLY' as const, deltaCents, observedDeclineCents, drivers: null };
  const sums: [number, number, number] = [0, 0, 0];
  for (const order of permutations) {
    const state: [number, number, number] = [...a];
    for (const index of order) {
      const old = revenue(state);
      state[index] = b[index];
      sums[index] += (revenue(state) - old) / permutations.length;
    }
  }
  if (sums.some(value => !Number.isSafeInteger(Math.round(value)))) {
    return { status: 'TOTAL_ONLY' as const, deltaCents, observedDeclineCents, drivers: null };
  }
  const trafficCents = Math.round(sums[0]);
  const conversionCents = Math.round(sums[1]);
  // Preserve the observed total exactly; ticket absorbs rounding residue only.
  const ticketCents = deltaCents - trafficCents - conversionCents;
  if (!Number.isSafeInteger(ticketCents)) return { status: 'TOTAL_ONLY' as const, deltaCents, observedDeclineCents, drivers: null };
  return { status: 'DECOMPOSED' as const, deltaCents, observedDeclineCents,
    drivers: { trafficCents, conversionCents, ticketCents } };
}
