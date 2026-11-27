import { describe, expect, it } from 'vitest';
import { growthOpportunity, observedFunnel } from '../src/growth/growth-opportunity';

const before = { visits: 1000, orders: 100, gmv: 10000, units: 120, stockAvailable: 300 };
const after = { visits: 600, orders: 60, gmv: 6000, units: 72, stockAvailable: 120 };

describe('growth opportunity', () => {
  it('estimates three alternative traffic scenarios at the current conversion and ticket', () => {
    const result = growthOpportunity(after, before, true);
    expect(result.underused).toBe(true);
    expect(result.scenarios.map(s=>[s.recoveryFraction,s.incrementalOrders,s.incrementalGmvCents])).toEqual([[0.25,10,100000],[0.5,20,200000],[1,40,400000]]);
    expect(result.best).toMatchObject({kind:'TRAFFIC',incrementalGmvCents:100000});
  });
  it('estimates conversion recovery without adding traffic and conversion alternatives', () => {
    const r = growthOpportunity({...after, orders:30, units:36, gmv:3000}, before, true);
    expect(r.scenarios.map(s=>s.kind)).toEqual(['TRAFFIC','TRAFFIC','TRAFFIC','CONVERSION','CONVERSION','CONVERSION']);
    expect(r.underused).toBe(false);
    expect(r.best?.recoveryFraction).toBe(0.25);
  });
  it('caps projected incremental orders at observed stock and units per order', () => {
    const r = growthOpportunity({...after,stockAvailable:6},before,true);
    expect(r.scenarios.every(s=>s.incrementalOrders===5&&s.stockLimited)).toBe(true);
    expect(growthOpportunity({...after,stockAvailable:0},before,true).scenarios).toEqual([]);
  });
  it('does not prioritize when stock or units are unavailable', () => {
    expect(growthOpportunity({...after,stockAvailable:null},before,true).best).toBeNull();
    expect(growthOpportunity({...after,units:null},before,true).best).toBeNull();
  });
  it('rejects incompatible windows, insufficient samples and invalid ratios', () => {
    for(const [m,compatible] of [[after,false],[{...after,visits:99},true],[{...after,orders:601},true],[{...after,gmv:null},true]] as const) {
      expect(growthOpportunity(m,before,compatible).status).toBe('INSUFFICIENT_EVIDENCE');
    }
  });
  it('does not invent impressions, carts or checkouts', () => {
    expect(observedFunnel(after,true)).toEqual({visits:600,orders:60,conversionPct:10,impressions:null,carts:null,checkout:null,coverage:'VISITS_AND_ORDERS_ONLY'});
    expect(observedFunnel(after,false).visits).toBeNull();
    expect(observedFunnel({visits:0,orders:0},true).conversionPct).toBeNull();
    expect(observedFunnel({visits:100,orders:0},true).conversionPct).toBe(0);
  });
  it('does not fabricate a positive opportunity on unchanged performance', () => {
    expect(growthOpportunity(before,before,true).status).toBe('NO_POSITIVE_SCENARIO');
  });
});
