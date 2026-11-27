import { describe,it,expect,vi } from 'vitest';
import { readReport,refreshAccess,shopeeUrl,verifyMarketplace,windowDays,type RequestFn } from '../src/connectors/sync';
import { createHmac } from 'node:crypto';
describe('adaptadores oficiais com respostas simuladas',()=>{
  it('Search Console preserva CTR zero e não inventa dias ausentes',async()=>{
    const request=vi.fn<RequestFn>().mockResolvedValue({rows:[{keys:['2025-01-01'],clicks:0,impressions:10,ctr:0,position:4}]});
    const r=await readReport('google_search_console',{siteUrl:'sc-domain:example.com'},{accessToken:'fixture'},'2025-01-01','2025-01-03',request);
    expect(r.rows).toEqual([{key:'2025-01-01',date:'2025-01-01',values:{clicks:0,impressions:10,ctr:0,position:4}}]);
    expect(request.mock.calls[0]?.[0]).toContain('sc-domain%3Aexample.com/searchAnalytics/query');
    expect(()=>windowDays('2025-02-30','2025-03-01')).toThrow();
  });
  it('assina Shopee HMAC e valida continuidade e região',async()=>{
    const cfg={partnerId:'123',shopId:'456',accountId:'shop'},secrets={partnerKey:'fixture-key',accessToken:'fixture-token'};
    const url=new URL(shopeeUrl('/api/v2/shop/get_shop_info',cfg,secrets,false,1700000000));
    expect(url.searchParams.get('sign')).toBe(createHmac('sha256','fixture-key').update('123/api/v2/shop/get_shop_info1700000000fixture-token456').digest('hex'));
    const request=vi.fn<RequestFn>().mockResolvedValueOnce({region:'BR',shop_name:'Fixture',shop_id:456}).mockResolvedValueOnce({response:{item:[{item_id:900,item_status:'NORMAL'}],has_next_page:true,next_offset:50}});
    expect(await readReport('shopee_official_api',cfg,secrets,'','',request)).toMatchObject({rows:[{key:'900'}],partial:true,nextCursor:'50'});
    const invalid=vi.fn<RequestFn>().mockResolvedValue({region:'SG',shop_name:'Fixture',shop_id:456});
    await expect(verifyMarketplace('shopee_official_api',cfg,secrets,invalid)).rejects.toThrow('IDENTIDADE_DIVERGENTE');
  });
  it('Amazon lê somente marketplace Brasil e transmite cursor sem expor credencial no URL',async()=>{
    const request=vi.fn<RequestFn>().mockResolvedValue({items:[{sku:'SKU-1',summaries:[{marketplaceId:'A2Q3Y263D00KWC',asin:'B012345678',itemName:'Produto'}]}],pagination:{nextToken:'next-private'},numberOfResults:40});
    const r=await readReport('amazon_sp_api',{accountId:'a',sellerId:'A12345'},{accessToken:'fixture-token'},'','',request,'old-private');
    expect(r).toMatchObject({rows:[{key:'SKU-1',values:{asin:'B012345678'}}],nextCursor:'next-private'});
    expect(request.mock.calls[0]?.[0]).toContain('pageToken=old-private');
    expect(request.mock.calls[0]?.[0]).not.toContain('fixture-token');
    expect(request.mock.calls[0]?.[1]).toMatchObject({headers:{'x-amz-access-token':'fixture-token'}});
  });
  it('renova token ML e conserva refresh rotacionado sem aceitar resposta inválida',async()=>{
    const cfg={accountId:'a',sellerId:'123'},s={accessToken:'old',refreshToken:'refresh',clientId:'id',clientSecret:'secret'};
    const request=vi.fn<RequestFn>().mockResolvedValueOnce({access_token:'new',refresh_token:'new-refresh'}).mockResolvedValueOnce({access_token:''});
    expect(await refreshAccess('mercado_livre_official_api',cfg,s,request)).toMatchObject({accessToken:'new',refreshToken:'new-refresh'});
    await expect(refreshAccess('mercado_livre_official_api',cfg,s,request)).rejects.toThrow('REFRESH_RECUSADO');
  });
});
