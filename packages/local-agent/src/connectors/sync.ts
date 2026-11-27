import { z } from 'zod';
import { createHmac } from 'node:crypto';

const digits=z.string().regex(/^\d{1,15}$/);
const account=z.string().min(1).max(160);
const optAccount={accountId:account.optional()};
const site=z.string().trim().max(500).refine(v=>{
  if(/^sc-domain:[a-z0-9.-]+\.[a-z]+$/i.test(v))return true;
  try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}
});
export const supported=['google_analytics4','google_search_console','mercado_livre_official_api','shopee_official_api','amazon_sp_api'] as const;
export type ConnectorId=typeof supported[number];
export type Config={accountId?:string;propertyId?:string;siteUrl?:string;sellerId?:string;partnerId?:string;shopId?:string};
export type Secrets={accessToken?:string;refreshToken?:string;clientId?:string;clientSecret?:string;partnerKey?:string};
export type SyncRow={key:string;date?:string;values:Record<string,string|number|boolean|null>};
export const providers:Record<ConnectorId,string>={google_analytics4:'GOOGLE_ANALYTICS4',google_search_console:'GOOGLE_SEARCH_CONSOLE',mercado_livre_official_api:'MARKETPLACE_SERVICE',shopee_official_api:'MARKETPLACE_SERVICE',amazon_sp_api:'MARKETPLACE_SERVICE'};
export function supportedId(id:string):id is ConnectorId{return (supported as readonly string[]).includes(id);}
export function validateConfig(id:ConnectorId,raw:unknown):Config{
  if(id==='google_analytics4')return z.object({propertyId:z.string().regex(/^\d{1,20}$/),...optAccount}).strict().parse(raw);
  if(id==='google_search_console')return z.object({siteUrl:site,...optAccount}).strict().parse(raw);
  if(id==='mercado_livre_official_api')return z.object({sellerId:digits,accountId:account}).strict().parse(raw);
  if(id==='shopee_official_api')return z.object({shopId:digits,partnerId:digits,accountId:account}).strict().parse(raw);
  return z.object({sellerId:z.string().regex(/^[A-Z0-9]{5,30}$/),accountId:account}).strict().parse(raw);
}
const secret=z.string().min(1).max(5000).regex(/^[A-Za-z0-9._~+/=:-]+$/);
export function validateSecrets(id:ConnectorId,raw:unknown):Secrets{
  const s=z.object({accessToken:secret.optional(),refreshToken:secret.optional(),clientId:secret.optional(),clientSecret:secret.optional(),partnerKey:secret.optional()}).strict().parse(raw);
  if(id==='shopee_official_api'){
    if(!s.partnerKey||!s.accessToken||s.clientId||s.clientSecret)throw Error('Shopee exige partner key e access token; refresh token opcional');
  }else{
    if(s.partnerKey||(!s.accessToken&&!s.refreshToken)||([s.refreshToken,s.clientId,s.clientSecret].some(Boolean)&&![s.refreshToken,s.clientId,s.clientSecret].every(Boolean)))throw Error('informe access token ou o conjunto refresh token, client ID e client secret');
  }
  return s;
}
export class ProviderError extends Error{
  constructor(public readonly status:string){super(status);}
}
const obj=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new ProviderError('RESPOSTA_INESPERADA');return v as Record<string,unknown>;};
const arr=(v:unknown):unknown[]=>{if(!Array.isArray(v))throw new ProviderError('RESPOSTA_INESPERADA');return v;};
const num=(v:unknown):number=>{if(typeof v!=='number'&&!(typeof v==='string'&&/^-?\d+(?:\.\d+)?$/.test(v)))throw new ProviderError('RESPOSTA_INESPERADA');const n=Number(v);if(!Number.isFinite(n))throw new ProviderError('RESPOSTA_INESPERADA');return n;};
const nonnegative=(v:unknown)=>{const n=num(v);if(n<0)throw new ProviderError('RESPOSTA_INESPERADA');return n;};
export function validDay(s:string):boolean{return /^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;}
export function windowDays(from:string,to:string){if(!validDay(from)||!validDay(to)||from>to||to>=new Date().toISOString().slice(0,10)||(Date.parse(to)-Date.parse(from))/86400000>=90)throw Error('período deve conter até 90 dias completos anteriores a hoje');}
export function shopeeUrl(path:string,c:Config,s:Secrets,refresh=false,now=Math.floor(Date.now()/1000)){
  const partner=c.partnerId!,shop=c.shopId!,token=s.accessToken??'';
  const base=partner+path+now+(refresh?'':token+shop);
  const u=new URL('https://partner.shopeemobile.com'+path);
  u.searchParams.set('partner_id',partner);u.searchParams.set('timestamp',String(now));u.searchParams.set('sign',createHmac('sha256',s.partnerKey!).update(base).digest('hex'));
  if(!refresh){u.searchParams.set('shop_id',shop);u.searchParams.set('access_token',token);}
  return u.toString();
}
export type RequestFn=(url:string,init:RequestInit)=>Promise<Record<string,unknown>>;
export async function boundedRequest(url:string,init:RequestInit={}):Promise<Record<string,unknown>>{
  let response:Response;
  try{response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new ProviderError('FALHA_DE_CONEXAO');}
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw new ProviderError('HTTP_'+response.status);}
  const reader=response.body?.getReader();if(!reader)throw new ProviderError('RESPOSTA_INESPERADA');
  const chunks:Uint8Array[]=[];let bytes=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2*1024*1024){await reader.cancel();throw new ProviderError('RESPOSTA_EXCEDE_LIMITE');}chunks.push(value);}}
  catch(e){if(e instanceof ProviderError)throw e;throw new ProviderError('FALHA_DE_CONEXAO');}
  try{return obj(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{throw new ProviderError('RESPOSTA_INESPERADA');}
}
export async function refreshAccess(id:ConnectorId,c:Config,s:Secrets,request:RequestFn):Promise<Secrets>{
  if(!s.refreshToken)throw new ProviderError('CREDENCIAL_EXPIRADA');
  let result:Record<string,unknown>;
  if(id==='shopee_official_api'){
    result=await request(shopeeUrl('/api/v2/auth/access_token/get',c,s,true),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({partner_id:Number(c.partnerId),shop_id:Number(c.shopId),refresh_token:s.refreshToken})});
    if(result.error)throw new ProviderError('REFRESH_RECUSADO');
  }else{
    const url=id==='mercado_livre_official_api'?'https://api.mercadolibre.com/oauth/token':id==='amazon_sp_api'?'https://api.amazon.com/auth/o2/token':'https://oauth2.googleapis.com/token';
    result=await request(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:s.clientId!,client_secret:s.clientSecret!,refresh_token:s.refreshToken}).toString()});
  }
  if(typeof result.access_token!=='string'||!secret.safeParse(result.access_token).success)throw new ProviderError('REFRESH_RECUSADO');
  if(result.refresh_token!==undefined&&!secret.safeParse(result.refresh_token).success)throw new ProviderError('REFRESH_RECUSADO');
  return {...s,accessToken:result.access_token,refreshToken:typeof result.refresh_token==='string'?result.refresh_token:s.refreshToken};
}
export async function verifyMarketplace(id:ConnectorId,c:Config,s:Secrets,request:RequestFn):Promise<void>{
  const bearer={authorization:'Bearer '+s.accessToken};
  if(id==='mercado_livre_official_api'){
    const v=await request('https://api.mercadolibre.com/users/me',{headers:bearer});
    if(String(v.id)!==c.sellerId||v.site_id!=='MLB')throw new ProviderError('IDENTIDADE_DIVERGENTE');
  }else if(id==='shopee_official_api'){
    const v=await request(shopeeUrl('/api/v2/shop/get_shop_info',c,s),{});
    if(v.error||v.region!=='BR'||typeof v.shop_name!=='string'||!v.shop_name||v.shop_id!==undefined&&String(v.shop_id)!==c.shopId)throw new ProviderError('IDENTIDADE_DIVERGENTE');
  }else if(id==='amazon_sp_api'){
    // The listings endpoint is explicitly seller-scoped, unlike marketplace participations.
    await amazonListings(c,s,request);
  }
}
async function amazonListings(c:Config,s:Secrets,request:RequestFn){
  const url='https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/'+encodeURIComponent(c.sellerId!)+'?marketplaceIds=A2Q3Y263D00KWC&includedData=summaries&pageSize=20';
  const v=await request(url,{headers:{'x-amz-access-token':s.accessToken!,'user-agent':'MarketplaceIntelligence/3.17.0 (Language=JavaScript)'}});
  if(v.errors)throw new ProviderError('RESPOSTA_INESPERADA');
  return v;
}
export async function readReport(id:ConnectorId,c:Config,s:Secrets,from:string,to:string,request:RequestFn):Promise<{rows:SyncRow[];partial:boolean;kind:string;note:string}>{
  const headers={authorization:'Bearer '+s.accessToken,'content-type':'application/json'};
  if(id==='google_analytics4'){
    windowDays(from,to);
    const metrics=['sessions','activeUsers','ecommercePurchases','purchaseRevenue'];
    const v=await request('https://analyticsdata.googleapis.com/v1beta/properties/'+c.propertyId+':runReport',{method:'POST',headers,body:JSON.stringify({dateRanges:[{startDate:from,endDate:to}],dimensions:[{name:'date'}],metrics:metrics.map(name=>({name})),limit:'100',returnPropertyQuota:true})});
    const list=arr(v.rows??[]),currency=typeof obj(v.metadata??{}).currencyCode==='string'?String(obj(v.metadata??{}).currencyCode):null;
    const rows=list.map(raw=>{const row=obj(raw),date=String(obj(arr(row.dimensionValues)[0]).value??'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'),values=arr(row.metricValues);if(!validDay(date)||date<from||date>to||values.length!==metrics.length)throw new ProviderError('RESPOSTA_INESPERADA');return {key:date,date,values:{sessions:nonnegative(obj(values[0]).value),activeUsers:nonnegative(obj(values[1]).value),ecommercePurchases:nonnegative(obj(values[2]).value),purchaseRevenue:num(obj(values[3]).value),currency}};});
    return {rows,partial:Number(v.rowCount??rows.length)>rows.length||rows.length===100||obj(v.metadata??{}).subjectToThresholding===true||obj(v.metadata??{}).dataLossFromOtherRow===true,kind:'GA4_DAILY',note:'Métricas da propriedade web, moeda da propriedade; não são KPIs do marketplace.'};
  }
  if(id==='google_search_console'){
    windowDays(from,to);
    const v=await request('https://www.googleapis.com/webmasters/v3/sites/'+encodeURIComponent(c.siteUrl!)+'/searchAnalytics/query',{method:'POST',headers,body:JSON.stringify({startDate:from,endDate:to,dimensions:['date'],type:'web',dataState:'final',rowLimit:100})});
    const rows=arr(v.rows??[]).map(raw=>{const x=obj(raw),date=String(arr(x.keys)[0]??'');if(!validDay(date)||date<from||date>to)throw new ProviderError('RESPOSTA_INESPERADA');const ctr=nonnegative(x.ctr);if(ctr>1)throw new ProviderError('RESPOSTA_INESPERADA');return {key:date,date,values:{clicks:nonnegative(x.clicks),impressions:nonnegative(x.impressions),ctr,position:nonnegative(x.position)}};});
    return {rows,partial:rows.length===100,kind:'GSC_DAILY',note:'Dados finais de busca Google; dias sem retorno permanecem ausentes.'};
  }
  if(id==='mercado_livre_official_api'){
    await verifyMarketplace(id,c,s,request);
    const v=await request('https://api.mercadolibre.com/users/'+c.sellerId+'/items/search?limit=50&offset=0',{headers});
    const ids=arr(v.results);if(ids.some(x=>typeof x!=='string'||!/^MLB\d+$/.test(x)))throw new ProviderError('RESPOSTA_INESPERADA');
    return {rows:ids.map(x=>({key:String(x),values:{externalId:String(x)}})),partial:Number(obj(v.paging??{}).total??ids.length)>ids.length||ids.length===50,kind:'ML_LISTING_IDS',note:'Primeira página de IDs do vendedor; não confirma vendas ou estoque.'};
  }
  if(id==='shopee_official_api'){
    await verifyMarketplace(id,c,s,request);
    const u=new URL(shopeeUrl('/api/v2/product/get_item_list',c,s));u.searchParams.set('offset','0');u.searchParams.set('page_size','50');u.searchParams.append('item_status','NORMAL');
    const v=await request(u.toString(),{});if(v.error)throw new ProviderError('SHOPEE_API_ERROR');
    const response=obj(v.response),rows=arr(response.item??[]).map(raw=>{const x=obj(raw),key=String(x.item_id??'');if(!/^\d+$/.test(key))throw new ProviderError('RESPOSTA_INESPERADA');return {key,values:{externalId:key,status:typeof x.item_status==='string'?x.item_status:null}};});
    return {rows,partial:response.has_next_page===true||rows.length===50,kind:'SHOPEE_LISTING_IDS',note:'Primeira página de itens NORMAL; não confirma métricas comerciais.'};
  }
  const v=await amazonListings(c,s,request);
  const rows=arr(v.items).map(raw=>{const x=obj(raw),key=typeof x.sku==='string'?x.sku:'';if(!key||key.length>250)throw new ProviderError('RESPOSTA_INESPERADA');const sum=arr(x.summaries??[]).map(obj).find(y=>y.marketplaceId==='A2Q3Y263D00KWC');if(!sum)throw new ProviderError('RESPOSTA_INESPERADA');return {key,values:{sku:key,asin:typeof sum.asin==='string'?sum.asin:null,title:typeof sum.itemName==='string'?sum.itemName.slice(0,500):null}};});
  return {rows,partial:!!obj(v.pagination??{}).nextToken||Number(v.numberOfResults??rows.length)>rows.length||rows.length===20,kind:'AMAZON_LISTING_SKUS',note:'Primeira página de SKUs do vendedor no Brasil; não confirma métricas comerciais.'};
}
