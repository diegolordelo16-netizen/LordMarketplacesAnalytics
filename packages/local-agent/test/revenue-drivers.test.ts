import { describe, expect, it } from 'vitest';
import { revenueDrivers } from '../src/growth/revenue-drivers';

const baseline = { gmv: 10000, orders: 100, visits: 1000 };
describe('growth revenue drivers', () => {
  it('isolates traffic at constant conversion and ticket', () => {
    const r = revenueDrivers({ gmv: 8000, orders: 80, visits: 800 }, baseline, true);
    expect(r.status).toBe('DECOMPOSED');
    expect(r.drivers).toEqual({ trafficCents: -200000, conversionCents: 0, ticketCents: 0 });
    expect(r.observedDeclineCents).toBe(200000);
  });
  it('isolates conversion', () => {
    expect(revenueDrivers({ gmv: 8000, orders: 80, visits: 1000 }, baseline, true).drivers)
      .toEqual({ trafficCents: 0, conversionCents: -200000, ticketCents: 0 });
  });
  it('isolates ticket', () => {
    expect(revenueDrivers({ ...baseline, gmv: 8000 }, baseline, true).drivers)
      .toEqual({ trafficCents: 0, conversionCents: 0, ticketCents: -200000 });
  });
  it('reconciles interacting changes exactly in cents', () => {
    const r = revenueDrivers({ gmv: 9123.45, orders: 83, visits: 1200 }, baseline, true);
    expect(r.status).toBe('DECOMPOSED');
    expect(Object.values(r.drivers ?? {}).reduce((s, n) => s + n, 0)).toBe(r.deltaCents);
    expect(r.deltaCents).toBe(-87655);
  });
  it('does not treat growth as a loss', () => {
    expect(revenueDrivers({ ...baseline, gmv: 20000 }, baseline, true).observedDeclineCents).toBe(0);
  });
  it('refuses incompatible periods and absent revenue', () => {
    expect(revenueDrivers(baseline, baseline, false).deltaCents).toBeNull();
    expect(revenueDrivers({ ...baseline, gmv: null }, baseline, true).observedDeclineCents).toBeNull();
  });
  it('keeps observed total but refuses undefined ratios', () => {
    expect(revenueDrivers({ gmv: 0, orders: 0, visits: 100 }, baseline, true)).toEqual({
      status: 'TOTAL_ONLY', deltaCents: -1000000, observedDeclineCents: 1000000, drivers: null,
    });
    expect(revenueDrivers({ ...baseline, visits: null }, baseline, true).status).toBe('TOTAL_ONLY');
    expect(revenueDrivers({ ...baseline, orders: 1001 }, baseline, true).drivers).toBeNull();
  });
});
