import { z } from 'zod';

const endpoint='https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live';
const locationCode=2076;

export const googleAdsTerm=z.string().trim().min(1).max(80)
  .refine(term=>term.split(/\s+/).length<=10&&!/[!@%,*(){}<>|^~;=?`]|\p{Extended_Pictographic}/u.test(term),
    'termo incompatível com o formato de consulta do Google Ads');

const count=z.number().int().nonnegative().nullish();
const monthly=z.object({year:z.number().int().min(2000).max(2200),month:z.number().int().min(1).max(12),search_volume:count});
const result=z.object({
  keyword:z.string(),search_volume:count,
  competition:z.enum(['LOW','MEDIUM','HIGH']).nullish(),
  competition_index:z.number().int().min(0).max(100).nullish(),
  monthly_searches:z.array(monthly).nullish(),
});
const envelope=z.object({
  status_code:z.number().int(),
  cost:z.number().nonnegative().nullish(),
  tasks:z.array(z.object({status_code:z.number().int(),result:z.array(result).nullable()})).length(1),
});
const termKey=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();

export async function lookupGoogleAdsVolume(login:string,password:string,terms:string[]) {
  const requested=new Map<string,string>();
  for(const term of terms){
    const key=termKey(term);
    if(!requested.has(key))requested.set(key,term);
  }
  const response=await fetch(endpoint,{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
    headers:{Authorization:'Basic '+Buffer.from(login+':'+password).toString('base64'),'Content-Type':'application/json'},
    body:JSON.stringify([{keywords:[...requested.values()],location_code:locationCode,language_code:'pt',search_partners:false}]),
  });
  if(!response.ok)throw Error('DataForSEO respondeu HTTP '+response.status);
  const parsed=envelope.safeParse(await response.json());
  if(!parsed.success)throw Error('resposta DataForSEO incompatível');
  const task=parsed.data.tasks[0];
  if(parsed.data.status_code!==20000||task?.status_code!==20000)throw Error('DataForSEO não concluiu a consulta');
  const byTerm=new Map<string,z.infer<typeof result>>();
  const repeated=new Set<string>();
  for(const row of task.result??[]){
    const key=termKey(row.keyword);
    if(!requested.has(key))continue;
    if(byTerm.has(key))repeated.add(key);
    byTerm.set(key,row);
  }
  return {
    source:'GOOGLE_ADS_VIA_DATAFORSEO',country:'BR',language:'pt',providerCostUsd:parsed.data.cost??null,
    items:[...requested].map(([key,term])=>{
      const row=repeated.has(key)?undefined:byTerm.get(key);
      const observations=row?.monthly_searches??[];
      const uniqueMonths=observations.filter((month,index)=>
        observations.findLastIndex(other=>other.year===month.year&&other.month===month.month)===index);
      return {term,volume:row?.search_volume??null,competition:row?.competition??null,competitionIndex:row?.competition_index??null,
        monthly:uniqueMonths.sort((a,b)=>b.year-a.year||b.month-a.month).slice(0,12)
          .map(point=>({year:point.year,month:point.month,volume:point.search_volume??null}))};
    }),
  };
}
