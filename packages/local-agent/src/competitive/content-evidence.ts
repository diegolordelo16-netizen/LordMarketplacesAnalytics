import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { LocalDatabase } from '../db/database';

const imageInput=z.object({
  url:z.string().url().max(2048).optional(),
  label:z.string().max(200).optional(),
  sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  dhash64:z.string().regex(/^[a-f0-9]{16}$/).optional(),
}).strict().refine(x=>!!(x.url||x.sha256||x.dhash64),'imagem sem evidência');
export const contentInput=z.object({
  accountId:z.string().min(1),ownProductId:z.string().min(1),
  relationId:z.string().min(1).optional(),side:z.enum(['OWN','RIVAL']),
  sourceClass:z.enum(['A_PRIMARY_UI','B_PLATFORM_EXPORT','F_USER_INPUT']),
  sourceUrl:z.string().url().max(2048).optional(),
  capturedAt:z.string().datetime().optional(),
  description:z.string().trim().min(1).max(30000).optional(),
  promotions:z.array(z.string().trim().min(1).max(1000)).max(40).optional(),
  images:z.array(imageInput).max(20).optional(),
}).strict().refine(x=>x.side==='OWN'?!x.relationId:!!x.relationId,'escopo incompatível')
  .refine(x=>x.description!==undefined||x.promotions!==undefined||x.images!==undefined,'nenhuma evidência informada');
type Image=z.infer<typeof imageInput>;
type Evidence={id:string;source_class:string;source_url:string|null;captured_at:string;description:string|null;promotions_json:string|null;images_json:string|null};
const normalize=(s:string)=>s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().trim().replace(/\s+/g,' ');
const words=(s:string)=>new Set(normalize(s).split(/[^\p{L}\p{N}]+/u).filter(x=>x.length>=3));
export function compareDescription(own:string|null,rival:string|null){
  if(!own||!rival)return null;
  const a=words(own),b=words(rival),common=[...a].filter(x=>b.has(x)),total=new Set([...a,...b]).size;
  return {ownLength:own.length,rivalLength:rival.length,lexicalSimilarityPct:total?Math.round(common.length*100/total):null,ownOnlyTerms:[...a].filter(x=>!b.has(x)).slice(0,100),rivalOnlyTerms:[...b].filter(x=>!a.has(x)).slice(0,100)};
}
export function comparePromotions(own:string[]|null,rival:string[]|null){
  if(own===null||rival===null)return null;
  const a=new Map(own.map(x=>[normalize(x),x])),b=new Map(rival.map(x=>[normalize(x),x]));
  return {common:[...a].filter(([k])=>b.has(k)).map(([,v])=>v),ownOnly:[...a].filter(([k])=>!b.has(k)).map(([,v])=>v),rivalOnly:[...b].filter(([k])=>!a.has(k)).map(([,v])=>v)};
}
export function perceptualSimilarity(a:string,b:string):number|null{
  if(!/^[a-f0-9]{16}$/.test(a)||!/^[a-f0-9]{16}$/.test(b))return null;
  let difference=0;
  for(let i=0;i<16;i++){
    let xor=parseInt(a[i]!,16)^parseInt(b[i]!,16);
    while(xor){difference+=xor&1;xor>>=1;}
  }
  return Math.round((64-difference)*1000/64)/10;
}
export function compareImages(own:Image[]|null,rival:Image[]|null){
  if(own===null||rival===null)return null;
  const pairs:Array<{ownIndex:number;rivalIndex:number;identicalFile:boolean|null;visualSimilarityPct:number|null}>=[];
  for(let i=0;i<own.length;i++)for(let j=0;j<rival.length;j++){
    const a=own[i]!,b=rival[j]!,identicalFile=a.sha256&&b.sha256?a.sha256===b.sha256:null;
    const score=a.dhash64&&b.dhash64?perceptualSimilarity(a.dhash64,b.dhash64):null;
    if(identicalFile!==null||score!==null)pairs.push({ownIndex:i,rivalIndex:j,identicalFile,visualSimilarityPct:score});
  }
  const bestMatches=rival.map((_,j)=>pairs.filter(p=>p.rivalIndex===j&&p.visualSimilarityPct!==null).sort((a,b)=>b.visualSimilarityPct!-a.visualSimilarityPct!)[0]??null);
  return {ownCount:own.length,rivalCount:rival.length,identicalPairs:pairs.filter(p=>p.identicalFile===true).length,comparableVisualPairs:pairs.filter(p=>p.visualSimilarityPct!==null).length,bestMatches,note:'dHash de 64 bits estima semelhança estrutural; não prova identidade, autoria nem qualidade.'};
}
function parsedArray<T>(raw:string|null|undefined):T[]|null{
  if(raw==null)return null;
  try{const value:unknown=JSON.parse(raw);return Array.isArray(value)?value as T[]:null;}catch{return null;}
}
function publicIdentity(raw:string,marketplace:string):string|null{
  let u:URL;try{u=new URL(raw);}catch{return null;}
  if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
  if(marketplace==='mercado_livre'&&['produto.mercadolivre.com.br','www.mercadolivre.com.br'].includes(u.hostname))return u.pathname.match(/(?:MLB-?)(\d{5,17})(?=[^0-9]|$)/i)?.[1]??null;
  if(marketplace==='shopee'&&u.hostname==='shopee.com.br')return u.pathname.match(/(?:-i\.|\/product\/)(\d+)[./](\d+)(?:$|\/)/)?.slice(1).join('.')??null;
  if(marketplace==='amazon'&&u.hostname==='www.amazon.com.br')return u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:$|\/)/i)?.[1]?.toUpperCase()??null;
  return null;
}
export function recordContent(db:LocalDatabase,raw:unknown){
  const i=contentInput.parse(raw);
  const own=db.row<{url:string|null;marketplace:string}>('SELECT o.url,o.marketplace FROM own_products o JOIN accounts a ON a.id=o.account_id AND a.is_active=1 WHERE o.id=? AND o.account_id=?',i.ownProductId,i.accountId);
  if(!own)throw Error('produto não pertence à conta ativa');
  const rival=i.side==='RIVAL'?db.row<{id:string;url:string|null;marketplace:string}>("SELECT c.id,c.url,c.marketplace FROM competitor_relations r JOIN competitor_candidates c ON c.id=r.candidate_id AND c.own_product_id=r.own_product_id WHERE r.id=? AND r.own_product_id=? AND r.status='APROVADO'",i.relationId,i.ownProductId):null;
  if(i.side==='RIVAL'&&!rival)throw Error('concorrente não pertence ao produto aprovado');
  const target=rival??own;
  let sourceUrl:null|string=null;
  if(i.sourceClass==='A_PRIMARY_UI'){
    if(!target.url||!i.sourceUrl||!publicIdentity(target.url,target.marketplace)||publicIdentity(target.url,target.marketplace)!==publicIdentity(i.sourceUrl,target.marketplace))throw Error('identidade pública não corresponde ao anúncio');
    const source=new URL(i.sourceUrl);sourceUrl=source.origin+source.pathname;
  }
  const capturedAt=i.capturedAt??new Date().toISOString();
  if(Date.parse(capturedAt)>Date.now()||(i.sourceClass==='A_PRIMARY_UI'&&Date.now()-Date.parse(capturedAt)>5*60000))throw Error('data de captura inválida');
  const id=randomUUID();
  db.db.prepare('INSERT INTO competitor_content_observations(id,account_id,own_product_id,candidate_id,side,source_class,source_url,captured_at,description,promotions_json,images_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,i.accountId,i.ownProductId,rival?.id??null,i.side,i.sourceClass,sourceUrl,capturedAt,i.description??null,i.promotions===undefined?null:JSON.stringify(i.promotions),i.images===undefined?null:JSON.stringify(i.images));
  return {id,capturedAt,sourceClass:i.sourceClass};
}
export function contentComparison(db:LocalDatabase,accountId:string,relationId:string){
  const relation=db.row<{own_product_id:string;candidate_id:string}>('SELECT r.own_product_id,r.candidate_id FROM competitor_relations r JOIN own_products o ON o.id=r.own_product_id JOIN competitor_candidates c ON c.id=r.candidate_id AND c.own_product_id=o.id WHERE r.id=? AND o.account_id=?',relationId,accountId);
  if(!relation)throw Error('relação não pertence à conta');
  const load=(side:string,candidate:string|null)=>db.rows<Evidence>('SELECT id,source_class,source_url,captured_at,description,promotions_json,images_json FROM competitor_content_observations WHERE account_id=? AND own_product_id=? AND side=? AND candidate_id IS ? ORDER BY captured_at DESC,rowid DESC LIMIT 100',accountId,relation.own_product_id,side,candidate);
  const own=load('OWN',null),rival=load('RIVAL',relation.candidate_id);
  const provenance=(r:Evidence|undefined)=>r?{id:r.id,sourceClass:r.source_class,capturedAt:r.captured_at,sourceUrl:r.source_url}:null;
  const od=own.find(r=>r.description!==null),rd=rival.find(r=>r.description!==null),op=own.find(r=>r.promotions_json!==null),rp=rival.find(r=>r.promotions_json!==null),oi=own.find(r=>r.images_json!==null),ri=rival.find(r=>r.images_json!==null);
  return {description:{comparison:compareDescription(od?.description??null,rd?.description??null),own:provenance(od),rival:provenance(rd)},promotions:{comparison:comparePromotions(parsedArray<string>(op?.promotions_json),parsedArray<string>(rp?.promotions_json)),own:provenance(op),rival:provenance(rp)},images:{comparison:compareImages(parsedArray<Image>(oi?.images_json),parsedArray<Image>(ri?.images_json)),own:provenance(oi),rival:provenance(ri)},note:'Amostras independentes; datas e fontes são explícitas. Ausência de observação não significa ausência de conteúdo ou promoção.'};
}
