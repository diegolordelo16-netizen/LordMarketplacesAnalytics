import type { LocalDatabase } from '../db/database';
import type { AgentContext } from './agents';

type SeoEvidence=NonNullable<AgentContext['externalSeo']>[number];
const terms=(value:string)=>new Set(value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t=>t.length>=3&&!['para','com','sem','dos','das','uma'].includes(t)));
const numberOrNull=(value:unknown,max=Number.MAX_SAFE_INTEGER)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max?value:null;
export function matchedSeoEvidence(rows:Array<{id:string;mode:string;scope:string;captured_at:string;result_json:string}>,title:string):SeoEvidence[]{
  const titleTerms=terms(title),seen=new Set<string>(),out:SeoEvidence[]=[];
  if(!titleTerms.size)return out;
  for(const run of rows){
    let items:unknown;try{items=JSON.parse(run.result_json);}catch{continue;}
    if(!Array.isArray(items))continue;
    for(const item of items.slice(0,100)){
      if(!item||typeof item!=='object'||typeof item.keyword!=='string')continue;
      const keyword=item.keyword.trim().slice(0,200),tokens=terms(keyword);
      if(!tokens.size||![...tokens].every(t=>titleTerms.has(t))&&[...tokens].filter(t=>titleTerms.has(t)).length/Math.max(tokens.size,titleTerms.size)<0.5)continue;
      const volume=numberOrNull(item.searchVolume),difficulty=numberOrNull(item.keywordDifficulty,100);
      if(volume===null&&difficulty===null)continue;
      const key=run.scope+'|'+keyword.toLowerCase();if(seen.has(key))continue;seen.add(key);
      out.push({id:run.id,keyword,volume,difficulty,scope:run.scope,capturedAt:run.captured_at,mode:run.mode});
      if(out.length>=10)return out;
    }
  }
  return out;
}
export function listingSeoEvidence(db:LocalDatabase,accountId:string,listingId:string){
  const listing=db.row<{title:string|null}>('SELECT title FROM listings WHERE account_id=? AND id=?',accountId,listingId);
  if(!listing?.title)return [];
  const now=new Date(),cutoff=new Date(now.getTime()-30*86400000).toISOString();
  const rows=db.rows<{id:string;mode:string;scope:string;captured_at:string;result_json:string}>("SELECT id,mode,scope,captured_at,result_json FROM seo_external_runs WHERE account_id=? AND status='OK' AND mode IN ('suggestions','related','ideas','overview','ranked','googleVolume') AND scope IN ('GOOGLE_BR_PT','GOOGLE_ADS_BR_PT') AND captured_at>=? AND captured_at<=? ORDER BY captured_at DESC,id DESC LIMIT 30",accountId,cutoff,now.toISOString());
  return matchedSeoEvidence(rows,listing.title);
}
