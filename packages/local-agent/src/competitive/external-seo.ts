import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { LocalDatabase } from '../db/database';
import type { SecretStore } from '../security/secrets';
import { googleAdsTerm, lookupGoogleAdsVolume } from '../connectors/dataforseo';
import { researchSeo, seoResearchInput, seoRequest, seoScope, safeDomain } from '../connectors/openseo';
type Input=z.infer<typeof seoResearchInput>;
type Result=Awaited<ReturnType<typeof researchSeo>>;
type Row=Result['rows'][number];
type Run={id:string;account_id:string;mode:string;query:string;device:string;location_name:string|null;scope:string;requested_at:string;captured_at:string|null;status:string;cost_usd:number|null;total_count:number|null;provider_code:number|null;result_json:string;schedule_id:string|null};
type Watch={id:string;account_id:string;keyword:string;domain:string;device:'desktop'|'mobile';location_name:string;interval_days:number;remaining:number;enabled:number;next_run_at:string;last_status:string|null};
const normalized=(s:string)=>s.normalize('NFKC').toLowerCase().trim().replace(/\s+/g,' ');
const lexical=(s:string)=>new Set(s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(x=>x.length>=2&&!['de','da','do','das','dos','para','com','sem','em','um','uma','os','as'].includes(x)));
function similarity(a:Set<string>,b:Set<string>){const union=new Set([...a,...b]);return union.size?[...a].filter(x=>b.has(x)).length/union.size:0;}
const rowsOf=(run:Run):Row[]=>JSON.parse(run.result_json) as Row[];
export function compareKeywordSamples(own:Row[],other:Row[]){
  const have=new Set(own.flatMap(r=>typeof r.keyword==='string'?[normalized(r.keyword)]:[])),seen=new Set<string>();
  return other.flatMap<Row>(r=>{
    if(typeof r.keyword!=='string')return [];
    const key=normalized(r.keyword);if(have.has(key)||seen.has(key))return [];seen.add(key);
    return [{...r,comparison:'NOT_OBSERVED_IN_OWN_SAMPLE'}];
  }).sort((a,b)=>Number(b.searchVolume??-1)-Number(a.searchVolume??-1));
}
export function groupSeoKeywords(rows:Row[],titles:string[]){
  const unique=new Map<string,Row>();
  for(const row of rows){if(typeof row.keyword==='string'&&!unique.has(normalized(row.keyword)))unique.set(normalized(row.keyword),row);}
  const catalog=titles.slice(0,1000).map(lexical);
  const groups:Array<{label:string;tokens:Set<string>;members:Array<Row&{catalogFit:number|null;opportunitySignal:number|null}>}>=[];
  for(const row of [...unique.values()].sort((a,b)=>Number(b.searchVolume??-1)-Number(a.searchVolume??-1)).slice(0,500)){
    const key=String(row.keyword),tokens=lexical(key);
    const fit=catalog.length?Math.max(...catalog.map(t=>similarity(tokens,t))):null;
    const volume=row.searchVolume,difficulty=row.keywordDifficulty;
    const signal=typeof volume==='number'&&volume>=0&&typeof difficulty==='number'&&difficulty>=0&&difficulty<=100&&fit!==null?
      Math.round(Math.min(1,Math.log10(volume+1)/5)*(1-difficulty/100)*fit*100):null;
    const member={...row,catalogFit:fit===null?null:Math.round(fit*100),opportunitySignal:signal};
    const match=groups.find(g=>similarity(tokens,g.tokens)>=0.5);
    if(match)match.members.push(member);else groups.push({label:key,tokens,members:[member]});
  }
  return groups.map(({label,members})=>({label,members}));
}
export function correlateSeoListings(rows:Row[],listings:Array<{id:string;title:string|null;external_id:string}>,profitRows:Array<{id:string;profitCents:number|null;marginPct:number|null;status:string}>,stockRows:Array<{id:string;stock:number|null;units:number|null;adSpend:number|null;capturedAt:string|null;window:unknown}>){
  const profits=new Map(profitRows.map(r=>[r.id,r])),inventory=new Map(stockRows.map(r=>[r.id,r]));
  const titles=listings.slice(0,1000).filter(r=>r.title).map(r=>({...r,tokens:lexical(r.title!)}));
  return rows.filter(r=>typeof r.keyword==='string').slice(0,100).map(row=>{
    const key=lexical(String(row.keyword)),matches=titles.map(l=>({l,fit:similarity(key,l.tokens)})).filter(x=>x.fit>=0.5).sort((a,b)=>b.fit-a.fit||a.l.id.localeCompare(b.l.id)).slice(0,3);
    return {keyword:row.keyword,searchVolume:row.searchVolume??null,keywordDifficulty:row.keywordDifficulty??null,
      matches:matches.map(({l,fit})=>{
        const profit=profits.get(l.id),stock=inventory.get(l.id),known=profit?.status==='RECORDED'&&profit.profitCents!==null&&profit.marginPct!==null;
        const profitCents=known?profit.profitCents:null,marginPct=known?profit.marginPct:null;
        const status=stock?.stock===0?'OUT_OF_STOCK':profitCents!==null&&profitCents<=0?'REVIEW_MARGIN':
          profitCents===null||marginPct===null||stock?.stock==null||row.searchVolume==null||row.keywordDifficulty==null?'INSUFFICIENT_DATA':'REVIEW_OPPORTUNITY';
        return {listingId:l.id,externalId:l.external_id,title:l.title,lexicalFitPct:Math.round(fit*100),profitCents,marginPct,
          stock:stock?.stock??null,units:stock?.units??null,adSpend:stock?.adSpend??null,capturedAt:stock?.capturedAt??null,observedWindow:stock?.window??null,status};
      })};
  });
}
export function observedRank(rows:Row[],domain:string){
  const target=safeDomain(domain);
  const matches=rows.filter(r=>r.type==='organic'&&typeof r.domain==='string'&&(r.domain.toLowerCase()===target||r.domain.toLowerCase().endsWith('.'+target))&&typeof r.position==='number'&&r.position>0);
  const best=matches.sort((a,b)=>Number(a.position)-Number(b.position))[0];
  return {position:best?.position??null,url:best?.url??null,status:best?'OBSERVED':'NOT_OBSERVED_IN_RETURNED_RESULTS'};
}
export const watchInput=z.object({accountId:z.string().min(1),keyword:z.string().trim().min(2).max(200),domain:z.string().trim().min(3).max(200),
  device:z.enum(['desktop','mobile']).default('desktop'),locationName:z.string().trim().min(2).max(160).optional(),intervalDays:z.number().int().min(1).max(30),
  maxRuns:z.number().int().min(1).max(30),confirmedPaidSchedule:z.literal(true)}).strict();
export class ExternalSeoWorkspace{
  private busy=false;
  constructor(private readonly db:LocalDatabase,private readonly secrets:SecretStore){}
  private credentials(){const login=this.secrets.get('seo:dataforseo:login'),password=this.secrets.get('seo:dataforseo:password');if(login&&password)return {login,password,source:'LOCAL_ENCRYPTED'};if(this.secrets.get('seo:dataforseo:disabled')==='true')return null;const l=process.env.MI_DATAFORSEO_LOGIN?.trim(),p=process.env.MI_DATAFORSEO_PASSWORD;return l&&p?{login:l,password:p,source:'ENVIRONMENT'}:null;}
  private scheduleEnabled(){const value=this.secrets.get('seo:dataforseo:schedules');return value!==null?value==='true':process.env.MI_DATAFORSEO_ENABLE_SCHEDULES==='true';}
  status(){return {configured:!!this.credentials(),source:this.credentials()?.source??null,schedulesEnabled:this.scheduleEnabled(),busy:this.busy};}
  configure(payload:unknown){const i=z.object({login:z.string().trim().min(1).max(254).regex(/^[^:\r\n]+$/),password:z.string().min(1).max(256),enableSchedules:z.boolean().default(false)}).strict().parse(payload);if(this.busy)throw Error('Aguarde a consulta em andamento.');this.db.transaction(()=>{this.secrets.set('seo:dataforseo:login',i.login);this.secrets.set('seo:dataforseo:password',i.password);this.secrets.set('seo:dataforseo:schedules',String(i.enableSchedules));this.secrets.delete('seo:dataforseo:disabled');if(!i.enableSchedules)this.db.db.prepare('UPDATE seo_rank_watches SET enabled=0').run();});return this.status();}
  disconnect(){if(this.busy)throw Error('Aguarde a consulta em andamento.');this.db.transaction(()=>{this.secrets.deletePrefix('seo:dataforseo:');this.secrets.set('seo:dataforseo:disabled','true');this.secrets.set('seo:dataforseo:schedules','false');this.db.db.prepare('UPDATE seo_rank_watches SET enabled=0').run();});return this.status();}
  account(accountId:string){if(!this.db.row('SELECT id FROM accounts WHERE id=? AND is_active=1',accountId))throw Error('Selecione uma conta ativa.');}
  async execute(accountId:string,input:Input,scheduleId:string|null=null){
    this.account(accountId);
    const parsed=seoResearchInput.parse(input),request=seoRequest(parsed);
    const credentials=this.credentials();if(!credentials)throw Error('Configure DataForSEO no painel SEO & Keywords.');
    if(this.busy)throw Error('Já existe uma consulta externa em andamento.');
    this.busy=true;
    const id=randomUUID();
    try{
      this.db.db.prepare('INSERT INTO seo_external_runs(id,account_id,mode,query,device,location_name,scope,requested_at,status,schedule_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id,accountId,parsed.mode,request.query,parsed.device,parsed.locationName??null,seoScope(parsed),new Date().toISOString(),'DISPATCHED',scheduleId);
      const result=await researchSeo(parsed,{MI_DATAFORSEO_LOGIN:credentials.login,MI_DATAFORSEO_PASSWORD:credentials.password});
      this.db.db.prepare('UPDATE seo_external_runs SET captured_at=?,status=?,cost_usd=?,total_count=?,provider_code=?,result_json=? WHERE id=? AND account_id=?')
        .run(result.capturedAt,result.status,result.costUsd,result.totalCount,result.providerCode,JSON.stringify(result.rows),id,accountId);
      return {...result,id,accountId};
    }catch(error){
      this.db.db.prepare("UPDATE seo_external_runs SET status='LOCAL_ERROR',captured_at=? WHERE id=? AND status='DISPATCHED'").run(new Date().toISOString(),id);
      throw error;
    }finally{this.busy=false;}
  }
  async volume(accountId:string,terms:string[],transient?:{login:string;password:string}){
    this.account(accountId);const input=z.array(googleAdsTerm).min(1).max(20).parse(terms);
    const credentials=transient??this.credentials();if(!credentials)throw Error('Configure DataForSEO no painel SEO & Keywords.');
    if(this.busy)throw Error('Já existe uma consulta externa em andamento.');
    this.busy=true;const id=randomUUID(),at=new Date().toISOString();
    try{
      this.db.db.prepare('INSERT INTO seo_external_runs(id,account_id,mode,query,device,scope,requested_at,status) VALUES(?,?,?,?,?,?,?,?)').run(id,accountId,'googleVolume',input.join(' | '),'desktop','GOOGLE_ADS_BR_PT',at,'DISPATCHED');
      const result=await lookupGoogleAdsVolume(credentials.login,credentials.password,input);
      const rows=result.items.map(r=>({keyword:r.term,searchVolume:r.volume,paidCompetition:r.competition,competitionIndex:r.competitionIndex,keywordDifficulty:null,monthlyHistory:r.monthly.map(p=>p.year+'-'+String(p.month).padStart(2,'0')+'='+String(p.volume??'—')).join(' | ')}));
      this.db.db.prepare("UPDATE seo_external_runs SET captured_at=?,status='OK',cost_usd=?,total_count=?,result_json=? WHERE id=? AND account_id=?").run(new Date().toISOString(),result.providerCostUsd,rows.length,JSON.stringify(rows),id,accountId);
      return {...result,id,accountId,rows,scope:'GOOGLE_ADS_BR_PT',status:'OK',costUsd:result.providerCostUsd,capturedAt:new Date().toISOString(),providerCode:null};
    }catch(error){
      this.db.db.prepare("UPDATE seo_external_runs SET status='LOCAL_ERROR',captured_at=? WHERE id=? AND status='DISPATCHED'").run(new Date().toISOString(),id);throw error;
    }finally{this.busy=false;}
  }
  history(accountId:string,limit:number){this.account(accountId);return this.db.rows<Omit<Run,'result_json'>>('SELECT id,account_id,mode,query,device,location_name,scope,requested_at,captured_at,status,cost_usd,total_count,provider_code,schedule_id FROM seo_external_runs WHERE account_id=? ORDER BY requested_at DESC,id DESC LIMIT ?',accountId,limit);}
  get(accountId:string,id:string){this.account(accountId);const run=this.db.row<Run>('SELECT * FROM seo_external_runs WHERE account_id=? AND id=?',accountId,id);if(!run)throw Error('Consulta não pertence à conta.');return run;}
  gap(accountId:string,ownId:string,otherId:string){
    const own=this.get(accountId,ownId),other=this.get(accountId,otherId);
    if(own.id===other.id||own.query===other.query||own.mode!=='ranked'||other.mode!=='ranked'||own.status!=='OK'||other.status!=='OK'||own.scope!==other.scope||!own.captured_at||!other.captured_at||Math.abs(Date.parse(own.captured_at)-Date.parse(other.captured_at))>7*86400000)throw Error('Escolha duas amostras de domínios diferentes, bem-sucedidas, do mesmo escopo e com até 7 dias de diferença.');
    const rows=compareKeywordSamples(rowsOf(own),rowsOf(other));
    return {scope:own.scope,ownDomain:own.query,otherDomain:other.query,ownSample:rowsOf(own).length,otherSample:rowsOf(other).length,rows,note:'Ausência na amostra não comprova ausência no ranking completo.'};
  }
  keywords(accountId:string,id:string){const run=this.get(accountId,id);if(!['suggestions','related','ideas','overview','ranked','googleVolume'].includes(run.mode)||run.status!=='OK')throw Error('Escolha uma consulta de palavras-chave bem-sucedida.');return rowsOf(run);}
  groups(accountId:string,id:string){
    const run=this.get(accountId,id);
    if(!['suggestions','related','ideas','overview','ranked','googleVolume'].includes(run.mode)||run.status!=='OK')throw Error('Escolha uma consulta de palavras-chave bem-sucedida.');
    const titles=this.db.rows<{title:string}>('SELECT title FROM listings WHERE account_id=? AND title IS NOT NULL ORDER BY id LIMIT 1000',accountId).map(x=>x.title);
    return {scope:run.scope,groups:groupSeoKeywords(rowsOf(run),titles),catalogTitles:titles.length,note:'Agrupamento lexical e sinal exploratório baseado em demanda Google, dificuldade e aderência lexical; não mede margem ou conversão.'};
  }
  addWatch(payload:unknown){
    const i=watchInput.parse(payload);this.account(i.accountId);const domain=safeDomain(i.domain),keyword=normalized(i.keyword),id=randomUUID(),now=new Date().toISOString();
    this.db.db.prepare('INSERT INTO seo_rank_watches(id,account_id,keyword,domain,device,location_name,interval_days,remaining,enabled,next_run_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,i.accountId,keyword,domain,i.device,i.locationName??'',i.intervalDays,i.maxRuns,1,new Date(Date.now()+i.intervalDays*86400000).toISOString(),now);
    return {id,nextRunAt:new Date(Date.parse(now)+i.intervalDays*86400000).toISOString(),remaining:i.maxRuns};
  }
  watches(accountId:string){this.account(accountId);return this.db.rows<Watch>('SELECT * FROM seo_rank_watches WHERE account_id=? ORDER BY created_at DESC LIMIT 200',accountId);}
  disable(accountId:string,id:string){this.account(accountId);const changes=this.db.db.prepare('UPDATE seo_rank_watches SET enabled=0 WHERE account_id=? AND id=?').run(accountId,id).changes;if(!changes)throw Error('Monitoramento não pertence à conta.');return {disabled:true};}
  rankHistory(accountId:string,id:string){
    this.account(accountId);const watch=this.db.row<Watch>('SELECT * FROM seo_rank_watches WHERE account_id=? AND id=?',accountId,id);
    if(!watch)throw Error('Monitoramento não pertence à conta.');
    return this.db.rows<Run>('SELECT * FROM seo_external_runs WHERE account_id=? AND schedule_id=? ORDER BY requested_at DESC LIMIT 100',accountId,id).map(run=>({id:run.id,at:run.captured_at??run.requested_at,costUsd:run.cost_usd,requestStatus:run.status,
      ...(run.status==='OK'||run.status==='EMPTY'?observedRank(rowsOf(run),watch.domain):{position:null,url:null,status:'NOT_VERIFIED'})}));
  }
  async processDue(){
    if(this.busy)return;
    // Explicit environment opt-in is required in addition to the finite per-watch approval.
    if(!this.scheduleEnabled()||!this.credentials())return;
    const now=new Date().toISOString();
    const due=this.db.row<Watch>("SELECT w.* FROM seo_rank_watches w JOIN accounts a ON a.id=w.account_id WHERE w.enabled=1 AND w.remaining>0 AND (w.last_status IS NULL OR w.last_status<>'DISPATCHED') AND w.next_run_at<=? AND a.is_active=1 ORDER BY w.next_run_at,w.id LIMIT 1",now);
    if(!due)return;
    // Reserve one call durably before dispatch. No catch-up bursts or retry on uncertain results.
    const next=new Date(Date.now()+due.interval_days*86400000).toISOString();
    const changes=this.db.db.prepare("UPDATE seo_rank_watches SET remaining=remaining-1,enabled=CASE WHEN remaining=1 THEN 0 ELSE enabled END,next_run_at=?,last_status='DISPATCHED' WHERE id=? AND enabled=1 AND remaining>0 AND next_run_at=?").run(next,due.id,due.next_run_at).changes;
    if(!changes)return;
    try{
      const result=await this.execute(due.account_id,{mode:'serp',query:due.keyword,limit:100,device:due.device,locationName:due.location_name||undefined,confirmed:true},due.id);
      this.db.db.prepare("UPDATE seo_rank_watches SET last_status=?,enabled=CASE WHEN ? IN ('OK','EMPTY') THEN enabled ELSE 0 END WHERE id=?").run(result.status,result.status,due.id);
    }catch{
      this.db.db.prepare("UPDATE seo_rank_watches SET last_status='LOCAL_ERROR',enabled=0 WHERE id=?").run(due.id);
    }
  }
}
