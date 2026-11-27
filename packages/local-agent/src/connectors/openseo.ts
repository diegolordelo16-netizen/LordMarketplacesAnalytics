import { z } from 'zod';

// normalizeIntent adapted from OpenSEO (MIT), Ben Senescu, commit 6f68494e92a695db17f4b22da25e84b9bf1e582c.
// See third-party/open-seo/LICENSE. Endpoint shapes adapted from labs.ts, serp.ts and backlinks.ts.
type KeywordIntent = 'unknown' | 'informational' | 'commercial' | 'transactional' | 'navigational';
export function normalizeIntent(raw: string | null | undefined): KeywordIntent {
  if (!raw) return "unknown";
  const value = raw.toLowerCase();
  if (value.includes("inform")) return "informational";
  if (value.includes("commerc")) return "commercial";
  if (value.includes("transact")) return "transactional";
  if (value.includes("navig")) return "navigational";
  return "unknown";
}

export const seoModes=['suggestions','related','ideas','overview','serp','ranked','domain','competitors','pages','backlinks','backlinkRows','referringDomains','backlinkPages','lighthouse','aiGoogle','aiChatGPT'] as const;
const modes=seoModes;
const backlinkModes=new Set<string>(['backlinks','backlinkRows','referringDomains','backlinkPages']);
export const seoResearchInput=z.object({
  mode:z.enum(modes),query:z.string().trim().min(2).max(200),
  limit:z.number().int().min(1).max(100).default(25),
  device:z.enum(['desktop','mobile']).default('desktop'),locationName:z.string().trim().min(2).max(160).optional(),confirmed:z.literal(true),
}).strict();
type ResearchInput=z.infer<typeof seoResearchInput>;
type Row=Record<string,string|number|null>;
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const str=(v:unknown):string|null=>typeof v==='string'&&v.trim()?v.trim().slice(0,1000):null;
const num=(v:unknown,max=Number.MAX_SAFE_INTEGER):number|null=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max?v:null;
const integer=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
export const safeDomain=(v:string)=>{
  const lower=v.toLowerCase();
  if(lower.length>253||! /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(lower))throw Error('Informe somente um domínio público, sem protocolo, porta ou caminho.');
  if(/\.(?:local|localhost|internal|test|invalid|example|onion)$/.test(lower))throw Error('Domínio público necessário.');
  return lower;
};
function safeAuditUrl(value:string){
  let url:URL;
  try{url=new URL(value);}catch{throw Error('Informe uma URL HTTPS pública.');}
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)throw Error('Use HTTPS sem credenciais, porta, parâmetros ou fragmento.');
  safeDomain(url.hostname);
  return url.href;
}
export function seoScope(input:ResearchInput){
  return backlinkModes.has(input.mode)?'GLOBAL_WEB_BACKLINKS':input.mode==='lighthouse'?'PUBLIC_WEB_LIGHTHOUSE':
    input.mode==='aiChatGPT'?'DATAFORSEO_CHATGPT_US_EN':input.mode==='aiGoogle'?'DATAFORSEO_GOOGLE_AI_BR_PT':
    input.mode==='serp'&&input.locationName?'GOOGLE_CUSTOM_LOCATION_PT':'GOOGLE_BR_PT';
}
const pathFor={
  suggestions:'/v3/dataforseo_labs/google/keyword_suggestions/live',
  related:'/v3/dataforseo_labs/google/related_keywords/live',
  ideas:'/v3/dataforseo_labs/google/keyword_ideas/live',
  serp:'/v3/serp/google/organic/live/advanced',
  ranked:'/v3/dataforseo_labs/google/ranked_keywords/live',
  domain:'/v3/dataforseo_labs/google/domain_rank_overview/live',
  backlinks:'/v3/backlinks/summary/live',
  overview:'/v3/dataforseo_labs/google/keyword_overview/live',
  competitors:'/v3/dataforseo_labs/google/serp_competitors/live',
  pages:'/v3/dataforseo_labs/google/relevant_pages/live',
  backlinkRows:'/v3/backlinks/backlinks/live',
  referringDomains:'/v3/backlinks/referring_domains/live',
  backlinkPages:'/v3/backlinks/domain_pages_summary/live',
  lighthouse:'/v3/on_page/lighthouse/live/json',
  aiGoogle:'/v3/ai_optimization/llm_mentions/search/live',
  aiChatGPT:'/v3/ai_optimization/llm_mentions/search/live',
} as const;
const taskSchema=z.object({
  status_code:z.number().int(),status_message:z.string().optional(),
  cost:z.number().finite().nonnegative().optional(),result:z.array(z.unknown()).nullable().optional(),
});
const envelopeSchema=z.object({status_code:z.number().int(),cost:z.number().finite().nonnegative().optional(),tasks:z.array(taskSchema).nullable().optional()});
const market={location_code:2076,language_code:'pt'};
export function seoRequest(input:ResearchInput){
  const query=input.mode==='lighthouse'?safeAuditUrl(input.query):['ranked','domain','pages','aiGoogle','aiChatGPT'].includes(input.mode)||backlinkModes.has(input.mode)?safeDomain(input.query):input.query;
  if(input.locationName&&input.mode!=='serp')throw Error('Localização personalizada disponível somente na SERP.');
  const base={...market,limit:input.limit};
  const keyword={...base,keyword:query,include_clickstream_data:false,include_serp_info:false,ignore_synonyms:false};
  const links={target:query,include_subdomains:true,include_indirect_links:true,exclude_internal_backlinks:true,backlinks_status_type:'live',rank_scale:'one_hundred'};
  const serpMarket=input.locationName?{location_name:input.locationName,language_code:'pt'}:market;
  const body=input.mode==='overview'?{...market,keywords:[query],include_clickstream_data:false}
    :input.mode==='competitors'?{...base,keywords:[query],item_types:['organic'],include_subdomains:true}
    :input.mode==='pages'?{...base,target:query}
    :input.mode==='backlinkRows'?{...links,limit:input.limit,order_by:['rank,desc'],mode:'as_is'}
    :input.mode==='referringDomains'||input.mode==='backlinkPages'?{...links,limit:input.limit,order_by:['backlinks,desc']}
    :input.mode==='lighthouse'?{url:query,for_mobile:input.device==='mobile',categories:['performance','accessibility','best_practices','seo']}
    :input.mode==='aiGoogle'||input.mode==='aiChatGPT'?{target:[{domain:query,include_subdomains:true,search_filter:'include',search_scope:['any']}],platform:input.mode==='aiChatGPT'?'chat_gpt':'google',...(input.mode==='aiChatGPT'?{location_code:2840,language_code:'en'}:market),limit:input.limit}
    :input.mode==='suggestions'?{...keyword,include_seed_keyword:true,exact_match:false}
    :input.mode==='related'?{...keyword,depth:2}
    :input.mode==='ideas'?{...base,keywords:[query],include_clickstream_data:false,include_serp_info:false,ignore_synonyms:false,closely_variants:false}
    :input.mode==='serp'?{...serpMarket,keyword:query,device:input.device,os:input.device==='mobile'?'android':'windows',depth:10}
    :input.mode==='ranked'?{...base,target:query,item_types:['organic']}
    :input.mode==='domain'?{...market,target:query,limit:1}
    :links;
  return {path:pathFor[input.mode],body,query};
}
// Compare only consecutive reported months, not missing entries or incomplete history.
function monthlyTrend(raw:unknown):Row{
  const periods=new Map<number,number>(),conflicts=new Set<number>();
  for(const entry of Array.isArray(raw)?raw:[]){
    const row=object(entry),year=integer(row.year),month=integer(row.month),volume=integer(row.search_volume);
    if(year===null||year<1900||year>2100||month===null||month<1||month>12||volume===null)continue;
    const key=year*12+month-1,previous=periods.get(key);
    if(previous!==undefined&&previous!==volume)conflicts.add(key);
    periods.set(key,volume);
  }
  const last=[...periods.keys()].sort((a,b)=>b-a)[0];
  if(last===undefined||conflicts.has(last))return {latestMonth:null,latestMonthVolume:null,monthlyChangePct:null};
  const current=periods.get(last)!,previous=conflicts.has(last-1)?undefined:periods.get(last-1);
  return {latestMonth:Math.floor(last/12)+'-'+String(last%12+1).padStart(2,'0'),latestMonthVolume:current,
    monthlyChangePct:previous!==undefined&&previous>0?Math.round((current-previous)/previous*10000)/100:null};
}
function keywordRow(raw:unknown):Row|null{
  const r=object(raw),keyword=str(r.keyword)?.toLowerCase();
  if(!keyword)return null;
  const info=object(r.keyword_info),props=object(r.keyword_properties),intent=object(r.search_intent_info);
  return {keyword,searchVolume:integer(info.search_volume),cpc:num(info.cpc),paidCompetition:num(info.competition,1),
    keywordDifficulty:num(props.keyword_difficulty,100),intent:normalizeIntent(str(intent.main_intent)),...monthlyTrend(info.monthly_searches)};
}
function mapRows(mode:ResearchInput['mode'],result:unknown,limit:number):Row[]{
  const root=object(result),items=Array.isArray(root.items)?root.items:[];
  if(mode==='lighthouse'){
    const cats=object(root.categories),audits=object(root.audits);
    const scores=['performance','accessibility','best-practices','seo'].flatMap(name=>{
      const score=num(object(cats[name]).score,1);
      return score===null?[]:[{type:'category',metric:name,value:Math.round(score*100),unit:'0-100',url:str(root.finalUrl)}];
    });
    if(!scores.length)return [];
    const metrics=['largest-contentful-paint','first-contentful-paint','total-blocking-time','cumulative-layout-shift','speed-index'];
    return [...scores,...metrics.flatMap(name=>{
      const audit=object(audits[name]),value=num(audit.numericValue);
      return value===null?[]:[{type:'metric',metric:name,value,unit:str(audit.numericUnit),url:str(root.finalUrl)}];
    }),...Object.entries(audits).flatMap(([name,raw])=>{
      const audit=object(raw),value=num(audit.score,1);
      return value!==null&&value<0.9&&audit.scoreDisplayMode==='numeric'&&str(audit.title)?[{type:'issue',metric:name,title:str(audit.title),value:Math.round(value*100),unit:'0-100'}]:[];
    }).slice(0,20)].slice(0,limit);
  }
  if(mode==='aiGoogle'||mode==='aiChatGPT')return items.flatMap(raw=>{
    const r=object(raw),question=str(r.question),answer=str(r.answer);
    if(!question&&!answer)return [];
    return [{question,answer,aiSearchVolume:integer(r.ai_search_volume),firstSeen:str(r.first_response_at),lastSeen:str(r.last_response_at),
      citedSources:Array.isArray(r.sources)?r.sources.slice(0,10).map(x=>str(object(x).url)).filter(Boolean).join(' | ')||null:null}];
  }).slice(0,limit);
  if(mode==='competitors')return items.flatMap(raw=>{
    const r=object(raw),domain=str(r.domain);if(!domain)return [];
    return [{domain,averagePosition:num(r.avg_position),medianPosition:num(r.median_position),visibility:num(r.visibility),estimatedTraffic:num(r.etv),keywordsCount:integer(r.keywords_count)}];
  }).slice(0,limit);
  if(mode==='pages')return items.flatMap(raw=>{
    const r=object(raw),o=object(object(r.metrics).organic),url=str(r.page_address);if(!url)return [];
    return [{url,organicKeywords:integer(o.count),estimatedTraffic:num(o.etv)}];
  }).slice(0,limit);
  if(mode==='backlinkRows')return items.flatMap(raw=>{
    const r=object(raw),url=str(r.url_from);if(!url)return [];
    return [{url,domain:str(r.domain_from),targetUrl:str(r.url_to),anchor:str(r.anchor),rank:num(r.rank,100),spamScore:num(r.backlink_spam_score??r.backlinks_spam_score,100),dofollow:typeof r.dofollow==='boolean'?String(r.dofollow):null,firstSeen:str(r.first_seen),lastSeen:str(r.last_seen)}];
  }).slice(0,limit);
  if(mode==='referringDomains'||mode==='backlinkPages')return items.flatMap(raw=>{
    const r=object(raw),name=str(mode==='referringDomains'?r.domain:r.page??r.url);if(!name)return [];
    return [{[mode==='referringDomains'?'domain':'url']:name,backlinks:integer(r.backlinks),referringDomains:integer(r.referring_domains),referringPages:integer(r.referring_pages),rank:num(r.rank,100),spamScore:num(r.backlinks_spam_score,100),brokenBacklinks:integer(r.broken_backlinks)}];
  }).slice(0,limit);
  if(mode==='backlinks')return [{domain:str(root.target),backlinks:integer(root.backlinks),referringDomains:integer(root.referring_domains),rank:num(root.rank,100),brokenBacklinks:integer(root.broken_backlinks)}];
  if(mode==='domain')return items.slice(0,1).map(raw=>{
    const r=object(raw),o=object(object(r.metrics).organic);
    return {domain:str(r.target),organicKeywords:integer(o.count),estimatedTraffic:num(o.etv)};
  });
  if(mode==='serp')return items.flatMap(raw=>{
    const r=object(raw);if(r.type!=='organic'&&r.type!=='paid')return [];
    const rank=integer(r.rank_absolute);if(!rank)return [];
    return [{type:String(r.type),position:rank,domain:str(r.domain),title:str(r.title),url:str(r.url)}];
  }).slice(0,limit);
  if(mode==='ranked')return items.flatMap(raw=>{
    const r=object(raw),kw=keywordRow(r.keyword_data),serp=object(object(r.ranked_serp_element).serp_item);
    if(!kw)return [];
    return [{...kw,position:integer(serp.rank_absolute),url:str(serp.url),estimatedTraffic:num(serp.etv)}];
  }).slice(0,limit);
  const source=mode==='suggestions'&&root.seed_keyword_data?[root.seed_keyword_data,...items]:items;
  const seen=new Set<string>();
  return source.flatMap(raw=>{
    const row=keywordRow(mode==='related'?object(raw).keyword_data:raw);
    if(!row||typeof row.keyword!=='string'||seen.has(row.keyword))return [];
    seen.add(row.keyword);return [row];
  }).slice(0,limit);
}
export function decodeSeoResponse(raw:unknown,input:ResearchInput){
  const response=envelopeSchema.parse(raw),task=response.tasks?.length===1?response.tasks[0]:undefined;
  const costUsd=response.cost??task?.cost??null;
  const base={source:'DATAFORSEO',scope:seoScope(input),mode:input.mode,
    query:input.query,capturedAt:new Date().toISOString(),costUsd,rows:[] as Row[],totalCount:null as number|null};
  if(response.status_code!==20000||!task)return {...base,status:'PROVIDER_ERROR',providerCode:response.status_code};
  if(task.status_code!==20000){
    if(task.status_code===40501&&/^no search results[.!]?$/i.test(task.status_message?.trim()??''))return {...base,status:'EMPTY',providerCode:task.status_code};
    return {...base,status:'PROVIDER_ERROR',providerCode:task.status_code};
  }
  if(!task.result?.length)return {...base,status:'EMPTY',providerCode:task.status_code};
  const root=object(task.result[0]);
  if(!Object.keys(root).length||(!['backlinks','lighthouse'].includes(input.mode)&&!Array.isArray(root.items)&&!root.seed_keyword_data))return {...base,status:'INVALID_RESPONSE',providerCode:task.status_code};
  const rows=mapRows(input.mode,root,input.limit);
  if(input.mode==='lighthouse'&&!rows.length)return {...base,status:'INVALID_RESPONSE',providerCode:task.status_code};
  if(input.mode==='backlinks'&&rows.every(row=>Object.entries(row).filter(([key])=>key!=='domain').every(([,value])=>value===null)))return {...base,status:'INVALID_RESPONSE',providerCode:task.status_code};
  return {...base,status:rows.length?'OK':'EMPTY',rows,totalCount:integer(root.total_count),providerCode:task.status_code};
}
async function boundedJson(response:Response):Promise<unknown>{
  const max=16*1024*1024;
  const length=Number(response.headers.get('content-length')??0);
  if(length>max){await response.body?.cancel();throw Error('Resposta acima do limite');}
  if(!response.body)throw Error('Resposta sem conteúdo');
  const reader=response.body.getReader(),parts:Uint8Array[]=[];
  let bytes=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;
      bytes+=value.byteLength;
      if(bytes>max){await reader.cancel();throw Error('Resposta acima do limite');}
      parts.push(value);
    }
  }finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export async function researchSeo(payload:unknown,env:NodeJS.ProcessEnv=process.env,transport:typeof fetch=fetch){
  const input=seoResearchInput.parse(payload),request=seoRequest(input);
  const login=env.MI_DATAFORSEO_LOGIN?.trim(),password=env.MI_DATAFORSEO_PASSWORD;
  if(!login||!password||login.includes(':'))throw Error('Configure MI_DATAFORSEO_LOGIN e MI_DATAFORSEO_PASSWORD no ambiente do agente local.');
  const base={source:'DATAFORSEO',scope:seoScope(input),mode:input.mode,
    query:request.query,capturedAt:new Date().toISOString(),costUsd:null,rows:[] as Row[],totalCount:null};
  let response:Response;
  try{
    response=await transport('https://api.dataforseo.com'+request.path,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(input.mode==='lighthouse'?60000:30000),
      headers:{Authorization:'Basic '+Buffer.from(login+':'+password).toString('base64'),'Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify([request.body]),
    });
  }catch{return {...base,status:'TRANSPORT_UNKNOWN',providerCode:null};}
  if(!response.ok)return {...base,status:'HTTP_ERROR',providerCode:response.status};
  try{return decodeSeoResponse(await boundedJson(response),{...input,query:request.query});}
  catch{return {...base,status:'INVALID_RESPONSE',providerCode:null};}
}
