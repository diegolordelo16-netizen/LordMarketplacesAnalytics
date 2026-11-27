import { describe, expect, it, vi } from 'vitest';
import { decodeSeoResponse, researchSeo, seoRequest, seoResearchInput } from '../src/connectors/dataforseo';

const input=seoResearchInput.parse({mode:'suggestions',query:'capacete',limit:5,confirmed:true});
const envelope=(result:unknown,status_code=20000,status_message='Ok.')=>({status_code:20000,cost:0.012,tasks:[{status_code,status_message,cost:0.012,result:[result]}]});
describe('OpenSEO / DataForSEO',()=>{
  it('preserva zero explícito, ausências e intenção; deduplica a semente',()=>{
    const seed={keyword:' Capacete ',keyword_info:{search_volume:0,cpc:null},keyword_properties:{keyword_difficulty:10},search_intent_info:{main_intent:'commercial'}};
    const r=decodeSeoResponse(envelope({seed_keyword_data:seed,items:[seed,{keyword:'capacete infantil'}]}),input);
    expect(r).toMatchObject({source:'DATAFORSEO',scope:'GOOGLE_BR_PT',costUsd:0.012,status:'OK',rows:[{keyword:'capacete',searchVolume:0,cpc:null,keywordDifficulty:10,intent:'commercial'},{keyword:'capacete infantil',searchVolume:null,keywordDifficulty:null,intent:'unknown'}]});
  });
  it('calcula tendência apenas com meses consecutivos observados e não inventa divisão por zero',()=>{
    const data=(monthly_searches:unknown)=>envelope({items:[{keyword:'capacete',keyword_info:{monthly_searches}}]});
    const jan={year:2026,month:1,search_volume:100},feb={year:2026,month:2,search_volume:150},apr={year:2026,month:4,search_volume:200};
    expect(decodeSeoResponse(data([feb,jan]),input).rows[0]).toMatchObject({latestMonth:'2026-02',latestMonthVolume:150,monthlyChangePct:50});
    expect(decodeSeoResponse(data([jan,apr]),input).rows[0]).toMatchObject({monthlyChangePct:null});
    expect(decodeSeoResponse(data([{...jan,search_volume:0},feb]),input).rows[0]).toMatchObject({monthlyChangePct:null});
  });
  it('não confunde erro tarifado com lista vazia',()=>{
    expect(decodeSeoResponse(envelope({},40501,"Invalid Field: 'target'."),input)).toMatchObject({status:'PROVIDER_ERROR',costUsd:0.012,rows:[]});
    expect(decodeSeoResponse(envelope({},40501,'No Search Results.'),input).status).toBe('EMPTY');
  });
  it('usa somente endpoints permitidos e Brasil/pt, bloqueia URLs arbitrárias',()=>{
    expect(seoRequest(input)).toMatchObject({path:'/v3/dataforseo_labs/google/keyword_suggestions/live',body:{location_code:2076,language_code:'pt',include_clickstream_data:false}});
    expect(()=>seoRequest({...input,mode:'ranked',query:'https://example.com/path'})).toThrow();
    expect(seoRequest({...input,mode:'serp',device:'mobile'}).body).toMatchObject({device:'mobile',os:'android',depth:10});
    expect(seoRequest({...input,mode:'backlinks',query:'example.com'}).body).toMatchObject({target:'example.com',rank_scale:'one_hundred'});
  });
  it('normaliza termos relacionados, rankings e backlinks',()=>{
    const keyword_data={keyword:'capacete',keyword_info:{search_volume:100}};
    expect(decodeSeoResponse(envelope({items:[{keyword_data}]}),{...input,mode:'related'}).rows[0]).toMatchObject({keyword:'capacete',searchVolume:100});
    expect(decodeSeoResponse(envelope({items:[{keyword_data,ranked_serp_element:{serp_item:{rank_absolute:3,url:'https://example.com/a',etv:4}}}]}),{...input,mode:'ranked'}).rows[0]).toMatchObject({position:3,estimatedTraffic:4});
    expect(decodeSeoResponse(envelope({target:'example.com',backlinks:0,referring_domains:2}),{...input,mode:'backlinks'})).toMatchObject({scope:'GLOBAL_WEB_BACKLINKS',rows:[{backlinks:0,referringDomains:2,rank:null}]});
  });
  it('exige autorização e credenciais, não repete falha nem devolve segredos',async()=>{
    const mock=vi.fn<typeof fetch>(async()=>{throw Error('secret');});
    await expect(researchSeo({...input,confirmed:false},{},mock)).rejects.toThrow();
    await expect(researchSeo(input,{},mock)).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
    const r=await researchSeo(input,{MI_DATAFORSEO_LOGIN:'user',MI_DATAFORSEO_PASSWORD:'secret'},mock);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[0]).toBe('https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live');
    expect(r).toMatchObject({status:'TRANSPORT_UNKNOWN',costUsd:null});
    expect(JSON.stringify(r)).not.toContain('secret');
  });
});
