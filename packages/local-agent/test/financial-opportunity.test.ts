import { describe, expect, it } from 'vitest';
import { financialOpportunity } from '../src/growth/financial-opportunity';
const scope={accountId:'a',listingId:'l',start:'2025-01-01T00:00:00.000Z',end:'2025-01-07T23:59:59.999Z'};
const record={id:'p',account_id:'a',listing_id:'l',period_start:scope.start,period_end:scope.end,source_class:'B_PLATFORM_EXPORT',evidence_json:'{"costFieldsConfirmed":true}',net_revenue_cents:80000,product_cost_cents:40000,packaging_cents:1000,shipping_cents:2000,marketplace_fees_cents:1000,taxes_cents:1000,ad_spend_cents:5000,refunds_cents:0,return_logistics_cents:0,cancellation_loss_cents:0,other_costs_cents:0};
const metrics={gmv:1000,netRevenue:800};
describe('financial opportunity',()=>{
  it('projects using profit divided by GMV, not net revenue',()=>{
    expect(financialOpportunity([record],scope,metrics,50000)).toMatchObject({status:'HISTORICAL_SCENARIO',profitCents:30000,historicalProfitOverGmvPct:30,projectedProfitBeforeExtraActionCostCents:15000});
  });
  it('retains negative economics',()=>{
    expect(financialOpportunity([{...record,product_cost_cents:90000}],scope,metrics,50000).projectedProfitBeforeExtraActionCostCents).toBe(-10000);
  });
  it('rejects missing and overlapping financial records',()=>{
    expect(financialOpportunity([],scope,metrics,50000).status).toBe('NO_RECORD');
    expect(financialOpportunity([record,record],scope,metrics,50000).status).toBe('CONFLICT');
    expect(financialOpportunity([{...record,period_end:'other'}],scope,metrics,50000).status).toBe('CONFLICT');
    expect(financialOpportunity([{...record,account_id:'b'}],scope,metrics,50000).status).toBe('CONFLICT');
  });
  it('requires confirmed complete costs and matching net revenue',()=>{
    expect(financialOpportunity([{...record,shipping_cents:null}],scope,metrics,50000).status).toBe('INVALID_RECORD');
    expect(financialOpportunity([{...record,evidence_json:'{}'}],scope,metrics,50000).status).toBe('INVALID_RECORD');
    expect(financialOpportunity([record],scope,{gmv:1000,netRevenue:799},50000).status).toBe('REVENUE_MISMATCH');
    expect(financialOpportunity([record],scope,{gmv:1000},50000).status).toBe('REVENUE_MISMATCH');
    expect(financialOpportunity([record],scope,metrics,null).status).toBe('NO_SCENARIO');
  });
});
