import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, statSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalDatabase } from '../src/db/database';
import { TaskScheduler } from '../src/scheduler/task-scheduler';
import { SecretStore, hashPassword, loadMachineSecret } from '../src/security/secrets';
import { GeminiClient } from '../src/ai/gemini-client';
import { KnowledgeBase } from '../src/ai/knowledge-base';
import { AutoUpgradeEngine, applyUnifiedDiff, extractTargetPaths, validatePatchSyntax } from '../src/ai/auto-upgrade';
import { matchedSeoEvidence } from '../src/ai/agent-evidence';
import { runAgents, synthesize, type AgentContext } from '../src/ai/agents';
import { CaptureService } from '../src/capture/capture-service';
import { LocalService, redactPII } from '../src/service';
import { evaluateGuard, GUARD_CHECKS } from '../src/guard/automation-guard';
import { mercadoLivreAdapter, shopeeAdapter, amazonAdapter, adapterForUrl, unsupportedCapabilities } from '../src/adapters';

let dir: string;
let db: LocalDatabase;
let service: LocalService;
let token = '';

function build(): LocalService {
  const secrets = new SecretStore(db, join(dir, 'secrets'));
  const gemini = new GeminiClient(db, secrets, async () => ({
    ok: true,
    status: 200,
    json: { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
  }));
  return new LocalService({
    db,
    secrets,
    tasks: new TaskScheduler(db),
    gemini,
    knowledge: new KnowledgeBase(db),
    autoUpgrade: new AutoUpgradeEngine(db, gemini, dir),
    capture: new CaptureService(db),
    version: '1.0.0-test',
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mi-test-'));
  db = new LocalDatabase({ file: join(dir, 'test.db') });
  db.migrate();
  service = build();
  const boot = await service.handle({ id: '1', protocolVersion: 1, method: 'auth.bootstrap', payload: { email: 'admin@local.test', password: 'senha-forte-123', displayName: 'Admin' } });
  expect(boot.ok).toBe(true);
  const login = await service.handle({ id: '2', protocolVersion: 1, method: 'auth.login', payload: { email: 'admin@local.test', password: 'senha-forte-123' } });
  expect(login.ok).toBe(true);
  token = (login.result as { token: string }).token;
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* já fechado */
  }
  rmSync(dir, { recursive: true, force: true });
});

const call = (method: string, payload?: unknown, useToken = true) =>
  service.handle({ id: 'r', protocolVersion: 1, method, payload, token: useToken ? token : undefined });

function seedImportAccount(id: string): void {
  const at = '2026-11-25T12:00:00.000Z';
  db.db.prepare('INSERT INTO accounts (id,marketplace,external_ref,display_name,handle,detection_confidence,verified_by_user,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id,'mercado_livre',`seller-${id}`,`Loja ${id}`,id,1,1,1,at,at);
}


describe('Plano de busca competitiva',()=>{
  it('prepara links públicos sem inventar candidatos e isola a conta',async()=>{
    const accountId='search-plan-a',other='search-plan-b';seedImportAccount(accountId);seedImportAccount(other);
    const own=await call('competitor.ownProduct.upsert',{accountId,marketplace:'mercado_livre',title:'Capacete teste',brand:'Marca',model:'Modelo',attributes:{material:'ABS'}});
    const id=(own.result as {id:string}).id;
    const r=await call('competitor.searchPlan',{accountId,ownProductId:id,marketplaces:['mercado_livre','shopee','amazon']});
    expect(r.result).toMatchObject({links:expect.arrayContaining([{marketplace:'amazon',kind:'TITLE',term:'Capacete teste',url:'https://www.amazon.com.br/s?k=Capacete%20teste',targetResults:20}])});
    expect((await call('competitor.searchPlan',{accountId:other,ownProductId:id,marketplaces:['amazon']})).ok).toBe(false);
    const capture={accountId,ownProductId:id,marketplace:'amazon',sourceUrl:'https://www.amazon.com.br/s?k=capacete',observedAt:new Date().toISOString(),candidates:[{externalId:'B012345678',title:'Capacete teste',url:'https://www.amazon.com.br/dp/B012345678',priceCents:29900,sponsored:null,observedOrder:1}]};
    expect((await call('competitor.capturePublicSearch',{...capture,accountId:other})).ok).toBe(false);
    expect((await call('competitor.capturePublicSearch',{...capture,candidates:[{...capture.candidates[0],url:'https://wrong.com/dp/B012345678'}]})).ok).toBe(false);
    expect((await call('competitor.capturePublicSearch',capture)).result).toMatchObject({observedCards:1,coverageVerified:false});
    expect(db.row('SELECT observed_order,price_cents,sponsored FROM competitor_public_search_observations WHERE account_id=?',accountId)).toMatchObject({observed_order:1,price_cents:29900,sponsored:null});
    const relation=db.row<{id:string}>('SELECT id FROM competitor_relations WHERE own_product_id=?',id)!;
    expect((await call('competitor.monitoring.history',{relationId:relation.id,accountId})).result).toMatchObject({publicObservations:[{observed_order:1,price_cents:29900}]});
    expect((await call('competitor.monitoring.history',{relationId:relation.id,accountId:other})).ok).toBe(false);
    expect((await call('competitor.approve',{relationId:relation.id})).ok).toBe(true);
    const latest={...capture,observedAt:new Date(Date.now()+1000).toISOString(),candidates:[{...capture.candidates[0],priceCents:28900}]};
    // Public observations are only eligible after their timestamp, so use historical timestamps.
    latest.observedAt=new Date(Date.now()-1000).toISOString();
    expect((await call('competitor.capturePublicSearch',latest)).ok).toBe(true);
    expect((await call('competitor.capturePublicSearch',latest)).ok).toBe(true);
    expect(db.row('SELECT COUNT(*) n FROM competitor_monitoring_points WHERE relation_id=?',relation.id)).toMatchObject({n:1});
    expect((await call('competitor.monitoring.record',{relationId:relation.id,capturedAt:'2025-01-01T00:00:00.000Z',priceCents:1})).ok).toBe(true);
    expect((await call('competitor.monitoring.history',{relationId:relation.id,accountId,limit:1})).result).toMatchObject({points:[{price_cents:28900}]});
    expect((await call('competitor.monitoring.set',{relationId:relation.id,state:'PAUSADO'})).ok).toBe(true);
    expect((await call('competitor.monitoring.record',{relationId:relation.id,priceCents:2})).ok).toBe(false);
    expect((await call('competitor.capturePublicSearch',{...latest,observedAt:new Date().toISOString()})).ok).toBe(true);
    expect(db.row('SELECT COUNT(*) n FROM competitor_monitoring_points WHERE relation_id=?',relation.id)).toMatchObject({n:2});
    expect((await call('competitor.approve',{relationId:relation.id})).ok).toBe(true);
    expect((await call('competitor.monitoring.record',{relationId:relation.id,priceCents:3,promotions:['Cupom observado']})).ok).toBe(true);
    expect((await call('competitor.evidence.compare',{relationId:relation.id,accountId})).result).toMatchObject({promotions:['Cupom observado']});

  });
});
describe('Pós-venda lexical por conta',()=>{
  it('preserva fonte, distingue menções de problemas comprovados e evita cruzamento de loja',async()=>{
    const accountId='voc-insights-a',other='voc-insights-b';seedImportAccount(accountId);seedImportAccount(other);
    await call('voc.ingest',{accountId,kind:'QUESTION',text:'Qual o tamanho e medida?'});
    await call('voc.ingest',{accountId,kind:'QUESTION',text:'Qual o tamanho?'});
    await call('voc.ingest',{accountId:other,kind:'COMPLAINT',text:'Produto com defeito'});
    const result=await call('voc.insights',{accountId,days:30});
    expect(result.result).toMatchObject({analyzed:2,groups:[{category:'SIZE_FIT',source:'F_USER_INPUT',count:2,recurring:true,classification:'LEXICAL_MENTION_NOT_CONFIRMED_PROBLEM'}]});
    expect(JSON.stringify(result)).not.toContain('QUALITY');
  });
});
describe('SEO externo integrado',()=>{
  it('isola histórico por loja, compara amostras e executa monitoramento opt-in sem repetir',async()=>{
    const accountId='seo-local-a',other='seo-local-b';seedImportAccount(accountId);seedImportAccount(other);
    vi.stubEnv('MI_DATAFORSEO_LOGIN','fixture-user');vi.stubEnv('MI_DATAFORSEO_PASSWORD','fixture-secret');vi.stubEnv('MI_DATAFORSEO_ENABLE_SCHEDULES','false');
    let count=0;
    vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{
      count++;
      const request=JSON.parse(String(init.body))[0];
      const items=request.target?[{keyword_data:{keyword:request.target==='own.com'?'capacete':'luva moto',keyword_info:{search_volume:100},keyword_properties:{keyword_difficulty:20}},ranked_serp_element:{serp_item:{rank_absolute:3}}}]:
        [{type:'organic',domain:'own.com',rank_absolute:4,url:'https://own.com/'}];
      return Response.json({status_code:20000,cost:0.01,tasks:[{status_code:20000,result:[{items,total_count:1}]}]});
    }));
    try{
      const query=(target:string)=>call('seo.external.research',{accountId,mode:'ranked',query:target,confirmed:true});
      const first=(await query('own.com')).result as {id:string},second=(await query('rival.com')).result as {id:string};
      expect(first.id).toBeTruthy();expect(second.id).toBeTruthy();
      expect((await call('seo.external.get',{accountId:other,id:first.id})).ok).toBe(false);
      expect((await call('seo.external.history',{accountId:other})).result).toEqual([]);
      expect((await call('seo.external.gap',{accountId,ownId:first.id,otherId:second.id})).result).toMatchObject({rows:[{keyword:'luva moto',comparison:'NOT_OBSERVED_IN_OWN_SAMPLE'}]});
      expect((await call('seo.external.groups',{accountId,id:first.id})).result).toMatchObject({groups:[{members:[{keyword:'capacete',opportunitySignal:null}]}]});
      expect(JSON.stringify((await call('seo.external.history',{accountId})).result)).not.toContain('fixture-secret');
      const periodStart='2025-01-01T00:00:00.000Z',periodEnd='2025-01-31T23:59:59.999Z';
      const stamp='2025-01-01T00:00:00.000Z';
      db.db.prepare('INSERT INTO listings(id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('seo-catalog-match',accountId,'mercado_livre','MLB987654321','Capacete','ACTIVE',stamp,stamp);
      const joined=await call('seo.external.opportunities',{accountId,id:first.id,periodStart,periodEnd});
      expect(joined.result).toMatchObject({rows:[{keyword:'capacete',matches:[{listingId:'seo-catalog-match',profitCents:null,stock:null,status:'INSUFFICIENT_DATA'}]}]});
      expect((await call('seo.external.opportunities',{accountId:other,id:first.id,periodStart,periodEnd})).ok).toBe(false);
      const watch=(await call('seo.watch.create',{accountId,keyword:'capacete',domain:'own.com',intervalDays:1,maxRuns:1,confirmedPaidSchedule:true})).result as {id:string};
      expect(watch.id).toBeTruthy();db.db.prepare("UPDATE seo_rank_watches SET next_run_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(watch.id);
      await service.processScheduledWork();expect(count).toBe(2);
      vi.stubEnv('MI_DATAFORSEO_ENABLE_SCHEDULES','true');await service.processScheduledWork();await service.processScheduledWork();expect(count).toBe(3);
      expect((await call('seo.watch.history',{accountId,id:watch.id})).result).toMatchObject([{position:4,status:'OBSERVED',costUsd:0.01}]);
      expect((await call('seo.watch.history',{accountId:other,id:watch.id})).ok).toBe(false);
      expect((await call('seo.watch.list',{accountId})).result).toMatchObject([{id:watch.id,remaining:0,enabled:0}]);
      const config=await call('seo.config.save',{login:'encrypted-login',password:'encrypted-password',enableSchedules:false});expect(config.result).toMatchObject({configured:true,source:'LOCAL_ENCRYPTED',schedulesEnabled:false});expect(JSON.stringify(config)).not.toContain('encrypted-password');
      expect((await call('seo.config.clear',{})).result).toMatchObject({configured:false,schedulesEnabled:false});
    }finally{vi.unstubAllGlobals();vi.unstubAllEnvs();}
  });
});

describe('capacidades adicionais 3.10.3', () => {
  it('persiste mais de 200 páginas, mantém filtros e retoma somente pendências no mesmo lote lógico', async () => {
    seedImportAccount('acct-sync-large');
    const { batchId } = (await call('sync.createAll',{scope:'ACCOUNT',accountId:'acct-sync-large',browserRequest:true})).result as {batchId:string};
    const url = (n:number) => 'https://vendedores.mercadolivre.com.br/pedidos?page='+n+'&start_date=2026-11-01&end_date=2026-11-30';
    const pages = Array.from({length:205},(_,i)=>({page:i+1,url:url(i+1),pageKind:'seller_orders',ok:true}));
    const leaseToken=(await call('sync.claimAccount',{batchId,accountId:'acct-sync-large'})).result as {leaseToken:string};
    const payload={batchId,accountId:'acct-sync-large',leaseToken:leaseToken.leaseToken,pagesScanned:205,pagesSucceeded:205,pages,seenUrls:pages.map(p=>p.url),pendingLinks:[{url:url(206),label:'próxima'}],maxPages:205,receiptProtocol:1};
    expect((await call('sync.accountProgress',payload)).ok).toBe(true);
    expect((await call('sync.accountProgress',{...payload,pages:pages.slice(0,204),pagesScanned:204,pagesSucceeded:204,seenUrls:pages.slice(0,204).map(p=>p.url)})).ok).toBe(false);
    expect((await call('sync.completeAccount',{batchId,accountId:'acct-sync-large',leaseToken:leaseToken.leaseToken,status:'COMPLETED',pagesScanned:205,pagesSucceeded:205})).ok).toBe(false);
    expect((await call('sync.completeAccount',{batchId,accountId:'acct-sync-large',leaseToken:leaseToken.leaseToken,status:'PARTIAL',pagesScanned:205,pagesSucceeded:205})).ok).toBe(true);
    const retried=await call('sync.retryFailed',{batchId,browserRequest:true});
    expect(retried.ok).toBe(true);
    const retryId=(retried.result as {batchId:string}).batchId;
    const info=(await call('sync.list',{batchId:retryId})).result as any;
    expect(info.batch.logical_batch_id).toBe(batchId);
    expect(info.accounts[0].pages_succeeded).toBe(205);
    expect(JSON.parse(info.accounts[0].progress_json).pendingLinks[0].url).toBe(url(206));
    expect(info.pageRuns).toHaveLength(205);
    const compact=(await call('sync.list',{batchId:retryId,compact:true,pageLimit:100,pageOffset:100})).result as any;
    expect(compact.totalPageRuns).toBe(205);
    expect(compact.pageRuns).toHaveLength(100);
    expect(compact.pageRuns[0].page_no).toBe(101);
    expect(compact.accounts[0].progress_json).toBeUndefined();
    expect(compact.accounts[0].pendingPages).toBe(1);
  });
  it('exclui outro navegador e outro lote; depois de expirar rejeita o token antigo', async () => {
    seedImportAccount('acct-lease');
    const first=(await call('sync.createAll',{scope:'ACCOUNT',accountId:'acct-lease'})).result as {batchId:string};
    const second=(await call('sync.createAll',{scope:'ACCOUNT',accountId:'acct-lease'})).result as {batchId:string};
    const req={batchId:first.batchId,accountId:'acct-lease'};
    const claim=(await call('sync.claimAccount',req)).result as {claimed:boolean;leaseToken:string};
    expect(claim.claimed).toBe(true);
    expect((await call('sync.claimAccount',{...req,batchId:second.batchId})).result).toMatchObject({claimed:false});
    expect((await call('sync.claimAccount',req)).result).toMatchObject({claimed:false});
    expect((await call('sync.claimAccount',{...req,leaseToken:claim.leaseToken})).result).toMatchObject({claimed:true});
    expect(JSON.stringify((await call('sync.list',{batchId:first.batchId})).result)).not.toContain('lease_hash');
    db.db.prepare("UPDATE sync_batch_accounts SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE batch_id=?").run(first.batchId);
    const renewed=(await call('sync.claimAccount',req)).result as {claimed:boolean;leaseToken:string};
    expect(renewed.claimed).toBe(true);
    expect(renewed.leaseToken).not.toBe(claim.leaseToken);
    expect((await call('sync.completeAccount',{...req,leaseToken:claim.leaseToken,status:'FAILED'})).ok).toBe(false);
    expect((await call('sync.completeAccount',{...req,leaseToken:renewed.leaseToken,status:'FAILED'})).ok).toBe(true);
    expect((await call('sync.claimAccount',{...req,batchId:second.batchId})).result).toMatchObject({claimed:true});
  });

  it('resume pós-venda por loja, janela e fonte e preserva notas ausentes',async()=>{
    const accountId='voc-overview',other='voc-overview-other';
    seedImportAccount(accountId);seedImportAccount(other);
    const recent=new Date(Date.now()-86400000).toISOString();
    const old=new Date(Date.now()-40*86400000).toISOString();
    const capture=await call('voc.ingestBatch',{accountId,items:[
      {kind:'REVIEW',text:'Ótimo produto',rating:4,observedAt:recent},
      {kind:'REVIEW',text:'Produto recebido',observedAt:recent},
      {kind:'REVIEW',text:'Avaliação antiga',rating:1,observedAt:old},
      {kind:'RETURN_REASON',text:'Tamanho divergente',externalRef:'return-1',observedAt:recent},
      {kind:'RETURN_REASON',text:'Tamanho divergente',externalRef:'return-2',observedAt:recent},
    ]});
    expect(capture.ok).toBe(true);
    expect((await call('voc.ingest',{accountId,kind:'REVIEW',text:'Registro manual',rating:2})).ok).toBe(true);
    expect((await call('voc.ingest',{accountId:other,kind:'QUESTION',text:'Prazo?'})).ok).toBe(true);
    expect((await call('capture.ingest',{marketplace:'mercado_livre',accountId,pageKind:'seller_reputation',url:'https://vendedores.mercadolivre.com.br/reputacao',sourceClass:'A_PRIMARY_UI',referenceAt:recent,collectedAt:recent,method:'content_script_dom',listings:[],accountMetrics:{reviewRating:4.5}})).ok).toBe(true);
    expect((await call('voc.overview',{accountId})).result).toMatchObject({
      summary:[
        {kind:'RETURN_REASON',source_class:'A_PRIMARY_UI',count:2,rated:0,average_rating:null},
        {kind:'REVIEW',source_class:'A_PRIMARY_UI',count:2,rated:1,average_rating:4},
        {kind:'REVIEW',source_class:'F_USER_INPUT',count:1,rated:1,average_rating:2},
      ],
      reputation:[{rating:4.5,reviewCount:null,partial:false}],
      returnReasons:[{reason:'Tamanho divergente',source_class:'A_PRIMARY_UI',count:2}],
    });
    expect((await call('voc.overview',{accountId:other})).result).toMatchObject({summary:[{kind:'QUESTION',rated:0,average_rating:null}],reputation:[]});
    expect((await call('voc.overview',{accountId:'unknown'})).ok).toBe(false);
  });

  it('compara a captura mais recente de concorrência sem misturar dados antigos ou lojas',async()=>{
    const accountId='comp-evidence-account',other='comp-evidence-other',relationId='comp-evidence-relation';
    seedImportAccount(accountId);seedImportAccount(other);
    const old='2025-01-01T12:00:00.000Z',recent='2025-01-02T12:00:00.000Z';
    db.db.prepare(`INSERT INTO own_products(id,account_id,marketplace,title,price_cents,shipping_cents,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run('comp-own',accountId,'mercado_livre','Produto próprio',1000,500,old,old);
    db.db.prepare(`INSERT INTO competitor_candidates(id,own_product_id,marketplace,title,source_class,discovery_method,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?)`).run('comp-candidate','comp-own','mercado_livre','Concorrente','A_PRIMARY_UI','TEST',old,old);
    db.db.prepare(`INSERT INTO competitor_relations(id,own_product_id,candidate_id,relation_kind,status,similarity_pct,rationale_json,suggested_by,suggested_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(relationId,'comp-own','comp-candidate','DIRETO','APROVADO',100,'{}','RULES',old);
    const source={relationId,sourceClass:'A_PRIMARY_UI'};
    expect((await call('competitor.evidence.record',{...source,capturedAt:recent,priceCents:1100,sponsored:false})).ok).toBe(true);
    expect((await call('competitor.evidence.record',{...source,capturedAt:old,priceCents:900,shippingCents:999,sponsored:true})).ok).toBe(true);
    expect((await call('competitor.evidence.record',{...source,capturedAt:'2099-01-01T00:00:00.000Z',priceCents:0})).ok).toBe(false);
    expect((await call('competitor.evidence.compare',{relationId,accountId:other})).ok).toBe(false);
    expect((await call('competitor.evidence.compare',{relationId,accountId})).result).toMatchObject({
      observedAt:recent,priceDifferenceCents:100,shippingDifferenceCents:null,sponsored:false,
    });
    expect(db.row('SELECT last_seen_at FROM competitor_candidates WHERE id=?','comp-candidate')).toMatchObject({last_seen_at:recent});
    const base={accountId,ownProductId:'comp-own',sourceClass:'F_USER_INPUT'};
    expect((await call('competitor.content.record',{...base,side:'OWN',description:'Capacete seguro leve',promotions:['Cupom 10%'],images:[{dhash64:'0000000000000000',sha256:'a'.repeat(64)}]})).ok).toBe(true);
    expect((await call('competitor.content.record',{...base,side:'RIVAL',relationId,description:'Capacete seguro esportivo',promotions:['Cupom 10%','Frete promocional'],images:[{dhash64:'000000000000000f',sha256:'b'.repeat(64)}]})).ok).toBe(true);
    expect((await call('competitor.content.record',{...base,accountId:other,side:'OWN',description:'intruso'})).ok).toBe(false);
    expect((await call('competitor.content.record',{...base,side:'RIVAL',relationId,sourceClass:'A_PRIMARY_UI',sourceUrl:'https://www.amazon.com.br/dp/B012345678',description:'origem incorreta'})).ok).toBe(false);
    const evidence=await call('competitor.evidence.compare',{relationId,accountId});
    expect(evidence.result).toMatchObject({content:{
      description:{comparison:{lexicalSimilarityPct:50,rivalOnlyTerms:['esportivo']},own:{sourceClass:'F_USER_INPUT'}},
      promotions:{comparison:{common:['Cupom 10%'],rivalOnly:['Frete promocional']}},
      images:{comparison:{identicalPairs:0,comparableVisualPairs:1,bestMatches:[{visualSimilarityPct:93.8}]}},
    }});

  });

  it('consulta volume Google Ads no recorte BR e conserva zero e ausência de dados',async()=>{
    const accountId='google-volume-br';
    seedImportAccount(accountId);
    const input={accountId,terms:['Capacete','capacete','Sem medida','Outro'],login:'fixture@example.test',password:'fixture-password',confirmedPaidRequest:true};
    let taskStatus=20000;
    const fetchMock=vi.fn(async (url:string,init:RequestInit)=>{
      expect(url).toBe('https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live');
      expect(init.redirect).toBe('error');
      expect(JSON.parse(String(init.body))).toEqual([{keywords:['Capacete','Sem medida','Outro'],location_code:2076,language_code:'pt',search_partners:false}]);
      return Response.json({status_code:20000,cost:0.02,tasks:[{status_code:taskStatus,result:[
        {keyword:'capacete',search_volume:0,competition:'LOW',competition_index:0,
          monthly_searches:[{year:2025,month:2,search_volume:null},{year:2025,month:3,search_volume:0}]},
        {keyword:'sem medida',search_volume:null},
        {keyword:'fora da consulta',search_volume:400},
      ]}]});
    });
    vi.stubGlobal('fetch',fetchMock);
    try{
      expect((await call('keyword.googleVolume',{...input,confirmedPaidRequest:false})).ok).toBe(false);
      expect((await call('keyword.googleVolume',{...input,terms:['emoji 😀']})).ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      const result=await call('keyword.googleVolume',input);
      expect(result.result).toMatchObject({source:'GOOGLE_ADS_VIA_DATAFORSEO',country:'BR',providerCostUsd:0.02,items:[
        {term:'Capacete',volume:0,competitionIndex:0,monthly:[{year:2025,month:3,volume:0},{year:2025,month:2,volume:null}]},
        {term:'Sem medida',volume:null},
        {term:'Outro',volume:null},
      ]});
      expect(JSON.stringify(result)).not.toContain(input.password);
      taskStatus=40501;
      expect((await call('keyword.googleVolume',input)).ok).toBe(false);
    }finally{
      vi.unstubAllGlobals();
    }
  });

  it('persiste detalhes de campanha e variação por conta sem somar aos totais e rejeita escopo inválido',async()=>{
    seedImportAccount('acct-details');
    seedImportAccount('acct-details-other');
    const at='2026-11-27T12:00:00.000Z';
    const base={marketplace:'mercado_livre',accountId:'acct-details',pageKind:'seller_ads',url:'https://vendedores.mercadolivre.com.br/publicidade',sourceClass:'A_PRIMARY_UI',referenceAt:at,collectedAt:at,method:'content_script_dom',listings:[]};
    const campaign={kind:'AD_CAMPAIGN',externalId:'C1',metrics:{adSpend:12.5},evidence:{adSpend:'Investimento: R$ 12,50'}};
    const data={...base,captureKey:'b'.repeat(64),details:[campaign]};
    const first=await call('capture.ingest',data);
    expect(first.ok).toBe(true);
    expect((first.result as any).detailRowsIngested).toBe(1);
    expect((await call('capture.ingest',data)).result).toEqual(first.result);
    const rows=(await call('capture.details',{accountId:base.accountId})).result as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].metrics.adSpend).toBe(12.5);
    expect((await call('capture.details',{accountId:'acct-details-other'})).result).toEqual([]);
    expect(db.row<{total:number}>('SELECT COUNT(*) total FROM account_snapshots WHERE account_id=?',base.accountId)?.total).toBe(0);
    expect((await call('capture.ingest',{...base,captureKey:'c'.repeat(64),details:[{...campaign,kind:'LISTING_VARIANT'}]})).ok).toBe(false);
    expect((await call('capture.ingest',{...base,captureKey:'d'.repeat(64),details:[{...campaign,evidence:{}}]})).ok).toBe(false);
    expect((await call('capture.ingest',{...base,pageKind:'seller_listings',captureKey:'e'.repeat(64),details:[campaign]})).ok).toBe(false);
  });

  it('vincula feedback somente a anúncio da mesma conta e preserva ID externo pendente',async()=>{
    seedImportAccount('acct-voc-link');seedImportAccount('acct-voc-other');
    const at='2026-11-27T12:00:00.000Z';
    const base={marketplace:'mercado_livre',accountId:'acct-voc-link',pageKind:'seller_listings',url:'https://vendedores.mercadolivre.com.br/anuncios',sourceClass:'A_PRIMARY_UI',referenceAt:at,collectedAt:at,method:'content_script_dom'};
    expect((await call('capture.ingest',{...base,listings:[{listingId:'MLB123456',price:20}]})).ok).toBe(true);
    const payload={accountId:base.accountId,items:[{kind:'REVIEW',text:'Produto excelente',externalRef:'R1',externalListingId:'MLB123456'},{kind:'QUESTION',text:'Tem estoque?',externalRef:'Q1',externalListingId:'MLB999999'}]};
    expect((await call('voc.ingestBatch',payload)).result).toMatchObject({linked:1,unresolved:1});
    const rows=(await call('voc.items',{accountId:base.accountId})).result as any[];
    expect(rows.find(row=>row.kind==='REVIEW').linked_external_id).toBe('MLB123456');
    expect(rows.find(row=>row.kind==='QUESTION').listing_id).toBeNull();
    expect((await call('voc.items',{accountId:'acct-voc-other'})).result).toEqual([]);
    expect((await call('capture.ingest',{...base,listings:[{listingId:'MLB999999',price:10}]})).ok).toBe(true);
    expect(((await call('voc.items',{accountId:base.accountId})).result as any[]).find(row=>row.kind==='QUESTION').linked_external_id).toBe('MLB999999');
    expect((await call('voc.ingestBatch',{accountId:base.accountId,items:[{...payload.items[0],externalListingId:'MLB999999'}]})).ok).toBe(false);
  });

  it('armazena taxas de reputação sem convertê-las em números de pedidos',async()=>{
    seedImportAccount('acct-reputation');
    const at='2026-11-27T12:00:00.000Z';
    const payload={marketplace:'mercado_livre',accountId:'acct-reputation',pageKind:'seller_reputation',url:'https://vendedores.mercadolivre.com.br/reputacao',sourceClass:'A_PRIMARY_UI',referenceAt:at,collectedAt:at,method:'content_script_dom',accountMetrics:{complaintRatePct:1.5,lateShipmentRatePct:2}};
    expect((await call('capture.ingest',payload)).result).toMatchObject({ok:true,accountSnapshotsIngested:1});
    const rows=(await call('capture.accountSnapshots',{accountId:payload.accountId})).result as any[];
    expect(rows[0].metrics).toEqual({complaintRatePct:1.5,lateShipmentRatePct:2});
    expect((await call('capture.ingest',{...payload,accountMetrics:{complaintRatePct:101}})).result).toMatchObject({ok:false});
  });

  it('persiste gráfico isolado com evidência e conta, sem criar total de loja',async()=>{
    seedImportAccount('acct-chart');seedImportAccount('acct-chart-other');
    const at='2026-11-27T12:00:00.000Z';
    const point={chartId:'sales',chartTitle:'Vendas por dia',series:'Receita (R$)',dimension:'2026-11-26',value:100.5,unit:'BRL',raw:'R$ 100,50'};
    const payload={marketplace:'mercado_livre',accountId:'acct-chart',pageKind:'seller_dashboard',url:'https://vendedores.mercadolivre.com.br/resumo',sourceClass:'A_PRIMARY_UI',referenceAt:at,collectedAt:at,method:'content_script_dom',captureKey:'c'.repeat(64),chartPoints:[point]};
    const result=await call('capture.ingest',payload);
    expect(result.result).toMatchObject({ok:true,chartPointsIngested:1,accountSnapshotsIngested:0});
    expect((await call('capture.ingest',payload)).result).toEqual(result.result);
    expect((await call('capture.chartPoints',{accountId:payload.accountId})).result).toEqual([expect.objectContaining({chart_id:'sales',dimension:'2026-11-26',value:100.5,raw_text:'R$ 100,50'})]);
    expect((await call('capture.chartPoints',{accountId:'acct-chart-other'})).result).toEqual([]);
    expect((await call('capture.ingest',{...payload,captureKey:'d'.repeat(64),chartPoints:[point,point]})).ok).toBe(false);
  });

  it('persiste páginas SPA na mesma URL apenas no lote avançado e preserva identidade ao retomar',async()=>{
    seedImportAccount('acct-spa');
    const req={scope:'ACCOUNT',accountId:'acct-spa',browserRequest:true,collectionMode:'ADVANCED_LISTINGS'};
    expect((await call('sync.createAll',{...req,scope:'ALL_ACTIVE_ACCOUNTS'})).ok).toBe(false);
    const {batchId}=(await call('sync.createAll',req)).result as {batchId:string};
    const {leaseToken}=(await call('sync.claimAccount',{batchId,accountId:req.accountId})).result as {leaseToken:string};
    const url='https://vendedores.mercadolivre.com.br/anuncios';
    const pages=[1,2].map(n=>({page:n,pageKind:'seller_listings',url,spaPage:n,listingFingerprint:String(n).repeat(64),listingIds:['MLB12345'+n],filterSignature:'',ok:true}));
    const payload={batchId,accountId:req.accountId,leaseToken,pagesScanned:2,pagesSucceeded:2,pages,seenUrls:[url],pendingLinks:[{url,label:'retomada'}],maxPages:5,unsupportedLinks:true};
    expect((await call('sync.accountProgress',payload)).ok).toBe(true);
    expect((await call('sync.accountProgress',{...payload,pages:[pages[0],{...pages[1],listingFingerprint:'a'.repeat(64)}]})).ok).toBe(false);
    expect((await call('sync.completeAccount',{batchId,accountId:req.accountId,leaseToken,status:'PARTIAL',pagesScanned:2,pagesSucceeded:2})).ok).toBe(true);
    const retry=(await call('sync.retryFailed',{batchId,browserRequest:true})).result as {batchId:string};
    const info=(await call('sync.list',{batchId:retry.batchId})).result as any;
    expect(info.batch.collection_mode).toBe('ADVANCED_LISTINGS');
    expect(info.pageRuns.map((page:any)=>page.spa_page)).toEqual([1,2]);
    expect(JSON.parse(info.accounts[0].progress_json).pages[1].listingIds).toEqual(['MLB123452']);
  });

  it('aprende somente rotas estruturais de contas verificadas, com isolamento e exclusão',async()=>{
    seedImportAccount('acct-learn-a');seedImportAccount('acct-learn-b');
    const accountId='acct-learn-a',origin='https://vendedores.mercadolivre.com.br';
    const payload={accountId,origin,route:'/reputacao',pageKind:'seller_reputation'};
    expect((await call('navigation.observe',payload)).result).toEqual({ok:true});
    expect((await call('navigation.observe',payload)).result).toEqual({ok:true});
    expect((await call('navigation.list',{accountId,origin})).result).toEqual([expect.objectContaining({route:'/reputacao',observations:2})]);
    expect((await call('navigation.list',{accountId:'acct-learn-b',origin})).result).toEqual([]);
    for(const invalid of [{...payload,route:'/reputacao/editar'},{...payload,route:'/reputacao?token=secret'},{...payload,route:'/reputacao/cliente'},{...payload,origin:'https://example.com'},{...payload,pageKind:'seller_listing_edit'},{...payload,rawText:'secret'}]){
      expect((await call('navigation.observe',invalid)).ok).toBe(false);
    }
    expect((await call('navigation.observe',{...payload,route:'/orders',pageKind:'seller_orders',fromRoute:'/reputacao'})).ok).toBe(true);
    expect((await call('navigation.observe',{...payload,route:'/stock',pageKind:'seller_inventory',fromRoute:'/unknown'})).ok).toBe(false);
    expect((await call('navigation.graph',{accountId,origin})).result).toEqual([expect.objectContaining({from_route:'/reputacao',to_route:'/orders',observations:1})]);
    expect((await call('navigation.graph',{accountId:'acct-learn-b',origin})).result).toEqual([]);
    expect((await call('navigation.observe',{...payload,fromRoute:'/reputacao',actionKind:'SPA_NEXT'})).ok).toBe(true);
    expect((await call('navigation.observe',{...payload,fromRoute:'/orders',actionKind:'FILTER_CHANGE'})).ok).toBe(false);
    const summary=(await call('navigation.summary',{accountId})).result as any;
    expect(summary.actions).toEqual([expect.objectContaining({route:'/reputacao',action_kind:'SPA_NEXT',observations:1})]);
    expect(summary.routes).toHaveLength(2);expect(summary.transitions).toHaveLength(1);
    expect((await call('navigation.clear',{accountId,origin})).result).toEqual({ok:true});
    expect((await call('navigation.graph',{accountId,origin})).result).toEqual([]);
    expect((await call('navigation.list',{accountId,origin})).result).toEqual([]);
  });

  it('persiste identidade SPA geral e rejeita regressão ou troca de fingerprint',async()=>{
    seedImportAccount('acct-spa-general');
    const accountId='acct-spa-general';
    const {batchId}=(await call('sync.createAll',{scope:'ACCOUNT',accountId,browserRequest:true})).result as {batchId:string};
    const {leaseToken}=(await call('sync.claimAccount',{batchId,accountId})).result as {leaseToken:string};
    const url='https://vendedores.mercadolivre.com.br/reputacao';
    const pages=[1,2].map(n=>({page:n,pageKind:'seller_reputation',url,spaPage:n,spaFingerprint:String(n).repeat(64),filterSignature:'',ok:true}));
    const payload={batchId,accountId,leaseToken,pagesScanned:2,pagesSucceeded:2,pages,seenUrls:[url],pendingLinks:[],maxPages:5};
    expect((await call('sync.accountProgress',payload)).ok).toBe(true);
    expect((await call('sync.accountProgress',{...payload,pages:[pages[0],{...pages[1],spaFingerprint:'a'.repeat(64)}]})).ok).toBe(false);
    expect((await call('sync.accountProgress',{...payload,pages:[pages[0],{...pages[1],spaFingerprint:undefined}]})).ok).toBe(false);
    const info=(await call('sync.list',{batchId})).result as any;
    expect(info.pageRuns.map((p:any)=>p.spa_page)).toEqual([1,2]);
    expect(JSON.parse(info.accounts[0].progress_json).pages[1].spaFingerprint).toBe('2'.repeat(64));
  });

  it('recibo de captura evita snapshots duplicados após resposta perdida e vincula URL e conta', async () => {
    seedImportAccount('acct-receipt');
    const at='2026-11-27T12:00:00.000Z';
    const payload={captureKey:'a'.repeat(64),marketplace:'mercado_livre',accountId:'acct-receipt',pageKind:'seller_dashboard',url:'https://vendedores.mercadolivre.com.br/resumo',sourceClass:'A_PRIMARY_UI',referenceAt:at,collectedAt:at,method:'content_script_dom',listings:[],accountMetrics:{orders:12,gmv:200}};
    const first=await call('capture.ingest',payload);
    expect(first.ok).toBe(true);
    expect((first.result as {ok:boolean}).ok).toBe(true);
    expect((await call('capture.ingest',{...payload,collectedAt:'2026-11-27T12:01:00.000Z'})).result).toEqual(first.result);
    expect(db.row<{total:number}>('SELECT COUNT(*) total FROM account_snapshots WHERE account_id=?','acct-receipt')?.total).toBe(1);
    expect((await call('capture.ingest',{...payload,url:'https://vendedores.mercadolivre.com.br/pedidos'})).ok).toBe(false);
    expect((await call('capture.ingest',{...payload,marketplace:'shopee'})).ok).toBe(false);
    const filtered={...payload,captureKey:'f'.repeat(64),filterSignature:'period=last 7 days',collectedAt:'2026-11-27T12:03:00.000Z'};
    const filteredResult=await call('capture.ingest',filtered);
    expect(filteredResult.ok).toBe(true);
    expect((await call('capture.ingest',filtered)).result).toEqual(filteredResult.result);
    expect((await call('capture.ingest',{...filtered,filterSignature:'period=last 30 days'})).ok).toBe(false);
    expect((await call('capture.ingest',{...payload,filterSignature:'period=last 7 days'})).ok).toBe(false);
    expect(db.row<{total:number}>('SELECT COUNT(*) total FROM account_snapshots WHERE account_id=?','acct-receipt')?.total).toBe(2);
    const voice={captureKey:'a'.repeat(64),sourceUrl:payload.url,accountId:payload.accountId,items:[{kind:'QUESTION',text:'O produto está disponível?'}]};
    expect((await call('voc.ingestBatch',voice)).ok).toBe(true);
    expect((await call('voc.ingestBatch',voice)).ok).toBe(true);
    expect(db.row<{total:number}>('SELECT COUNT(*) total FROM customer_voice_items WHERE account_id=?','acct-receipt')?.total).toBe(1);
    expect((await call('voc.ingestBatch',{...voice,filterSignature:'period=last 30 days'})).ok).toBe(false);
  });

  it('entrega à extensão apenas lotes solicitados pelo dashboard e protege a retomada', async () => {
    seedImportAccount('acct-browser-request');
    const payload = { scope: 'ACCOUNT', accountId: 'acct-browser-request' };
    const direct = await call('sync.createAll', payload);
    expect(direct.ok).toBe(true);
    expect((await call('sync.claimBrowserRequest', {})).result).toEqual({ claimed: false });

    const queued = await call('sync.createAll', { ...payload, browserRequest: true });
    const { batchId } = queued.result as { batchId: string };
    expect(queued.ok).toBe(true);
    const attempts = await Promise.all([call('sync.claimBrowserRequest', {}), call('sync.claimBrowserRequest', {})]);
    expect(attempts.map((result) => result.result)).toEqual([
      { claimed: true, batchId, recoveredStaleLease: false }, { claimed: false },
    ]);
    const lease = (await call('sync.claimAccount',{batchId,accountId:payload.accountId})).result as {claimed:boolean;leaseToken:string};
    expect(lease.claimed).toBe(true);
    expect((await call('sync.claimAccount',{batchId,accountId:payload.accountId})).result).toMatchObject({claimed:false});
    const firstPage = 'https://vendedores.mercadolivre.com.br/resumo';
    const pending = 'https://vendedores.mercadolivre.com.br/vendas';
    expect((await call('sync.accountProgress', {
      batchId, accountId: payload.accountId, leaseToken:lease.leaseToken, pagesScanned: 1, pagesSucceeded: 1,
      pages: [{ page: 1, pageKind: 'seller_dashboard', url: firstPage, ok: true }],
      pendingLinks: [{ url: pending, label: 'Vendas' }], seenUrls: [firstPage], maxPages: 8,
    })).ok).toBe(true);
    const premature = await call('sync.completeAccount', { batchId, accountId: payload.accountId, leaseToken:lease.leaseToken, status: 'COMPLETED', pagesScanned: 1, pagesSucceeded: 1 });
    expect(premature.error?.message).toContain('páginas pendentes');
    db.db.prepare("UPDATE sync_batches SET browser_claimed_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(batchId);
    expect((await call('sync.claimBrowserRequest', {})).result).toEqual({ claimed: false });
    db.db.prepare("UPDATE sync_batch_accounts SET progress_updated_at='2000-01-01T00:00:00.000Z' WHERE batch_id=?").run(batchId);
    expect((await call('sync.claimBrowserRequest', {})).result).toEqual({ claimed: true, batchId, recoveredStaleLease: true });
    expect((await call('sync.list', { batchId })).result).toMatchObject({
      accounts: [{ status: 'RUNNING', pages_scanned: 1 }],
      pageRuns: [{ page_no: 1, page_url: firstPage }],
    });
  });

  it('semeia marketplaces e permite lote em todas as contas de marketplaces habilitados', async () => {
    seedImportAccount('acct-sync-ml');
    const at = '2026-11-25T12:00:00.000Z';
    db.db.prepare('INSERT INTO accounts (id,marketplace,external_ref,display_name,handle,detection_confidence,verified_by_user,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('acct-sync-shopee','shopee','seller-shopee','Loja Shopee','seller-shopee',1,1,1,at,at);
    const created = await call('sync.createAll', { scope: 'ALL_ENABLED_MARKETPLACES' });
    expect(created.ok).toBe(true);
    const result = created.result as { batchId: string; accounts: Array<{ account_id: string; marketplace: string }> };
    expect(result.accounts.map((a) => a.marketplace)).toEqual(['mercado_livre','shopee']);
    const mlClaim=(await call('sync.claimAccount',{batchId:result.batchId,accountId:'acct-sync-ml'})).result as {leaseToken:string};
    const mlPages=[1,2].map(page=>({page,pageKind:'seller_orders',url:'https://vendedores.mercadolivre.com.br/pedidos?page='+page,ok:true}));
    expect((await call('sync.completeAccount',{batchId:result.batchId,accountId:'acct-sync-ml',leaseToken:mlClaim.leaseToken,status:'COMPLETED',pagesScanned:2,pagesSucceeded:2})).ok).toBe(false);
    expect((await call('sync.accountProgress',{batchId:result.batchId,accountId:'acct-sync-ml',leaseToken:mlClaim.leaseToken,pagesScanned:2,pagesSucceeded:2,pages:mlPages,seenUrls:mlPages.map(p=>p.url),pendingLinks:[],maxPages:50})).ok).toBe(true);
    const first = await call('sync.completeAccount', { batchId: result.batchId, accountId: 'acct-sync-ml', leaseToken:mlClaim.leaseToken, status: 'COMPLETED', pagesScanned: 2, pagesSucceeded: 2 });
    expect(first.ok).toBe(true);
    const shClaim=(await call('sync.claimAccount',{batchId:result.batchId,accountId:'acct-sync-shopee'})).result as {leaseToken:string};
    const second = await call('sync.completeAccount', { batchId: result.batchId, accountId: 'acct-sync-shopee', leaseToken:shClaim.leaseToken, status: 'SKIPPED', pagesScanned: 0, pagesSucceeded: 0, error: 'aba não aberta' });
    expect((second.result as { batchStatus: string }).batchStatus).toBe('PARTIAL');
  });

  it('persiste modos operacionais sem liberar publicações nem escritas remotas', async () => {
    const changed = await call('operation.mode.set', { mode: 'AUTO_PILOT' });
    expect(changed.ok).toBe(true);
    expect((changed.result as any).remoteWritesEnabled).toBe(false);
    expect((changed.result as any).policy.publish).toBe(false);
    expect((changed.result as any).policy.requireHumanApproval).toBe(true);
    const loaded = await call('operation.mode.get', {});
    expect((loaded.result as any).mode).toBe('AUTO_PILOT');
    expect((loaded.result as any).hardLimits.campaignExecution).toBe(false);
  });

  it('calcula lucro realizado somente de valores e evidência informados', async () => {
    seedImportAccount('acct-realized');
    const payload = {
      accountId: 'acct-realized', periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-11-30T23:59:59.000Z',
      netRevenueCents: 100000, productCostCents: 30000, packagingCents: 2000, shippingCents: 5000,
      marketplaceFeesCents: 8000, taxesCents: 3000, adSpendCents: 4000, refundsCents: 1000,
      returnLogisticsCents: 500, cancellationLossCents: 500, otherCostsCents: 1000,
      sourceClass: 'F_USER_INPUT', evidence: { source: 'relatório de conciliação', file: 'conciliação-novembro.csv' },
    };
    const upsert = await call('finance.realized.upsert', payload);
    expect(upsert.ok).toBe(true);
    expect((upsert.result as any).realizedProfitCents).toBe(45000);
    expect((upsert.result as any).classification).toBe('REALIZED_FROM_REPORTED_INPUT');
    const summary = await call('finance.realized.summary', { accountId: 'acct-realized' });
    expect((summary.result as any).realizedProfitCents).toBe(45000);
    expect((await call('finance.realized.summary',{accountId:'acct-realized',periodStart:'2025-01-01T00:00:00.000Z',periodEnd:'2025-01-02T00:00:00.000Z'})).result).toMatchObject({realizedProfitCents:null,netRevenueCents:null,confidence:'NO_DATA'});
    expect((await call('finance.realized.upsert',{...payload,periodStart:'2026-11-15T00:00:00.000Z'})).ok).toBe(true);
    expect((await call('finance.realized.summary',{accountId:'acct-realized'})).result).toMatchObject({realizedProfitCents:null,confidence:'CONFLICTING_RECORDS',overlappingPeriods:true});
  });


  it('rentabilidade exige registros do mesmo período e não confunde falta de dados com margem negativa',async()=>{
    const accountId='acct-profitability';seedImportAccount(accountId);
    const at='2025-01-31T23:59:59.999Z',periodStart='2025-01-01T00:00:00.000Z';
    for(const id of ['profit-negative','profit-missing'])db.db.prepare('INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,accountId,'mercado_livre',id,id,'ACTIVE',at,at);
    const payload={accountId,listingId:'profit-negative',periodStart,periodEnd:at,netRevenueCents:10000,productCostCents:9000,packagingCents:100,shippingCents:1000,marketplaceFeesCents:1000,taxesCents:100,adSpendCents:500,refundsCents:0,returnLogisticsCents:0,cancellationLossCents:0,otherCostsCents:0,sourceClass:'F_USER_INPUT',evidence:{source:'relatório de teste'}};
    expect((await call('finance.realized.upsert',{...payload,adSpendCents:undefined})).ok).toBe(false);
    expect((await call('finance.realized.upsert',payload)).ok).toBe(true);
    const data=(await call('finance.profitability',{accountId,periodStart,periodEnd:at})).result as any;
    expect(data.listings.find((l:any)=>l.id==='profit-negative')).toMatchObject({profitCents:-1700,marginPct:-17,negative:true,status:'RECORDED'});
    expect(data.listings.find((l:any)=>l.id==='profit-missing')).toMatchObject({profitCents:null,negative:false,status:'NO_DATA'});
    expect((await call('finance.realized.upsert',{...payload,sourceClass:'B_PLATFORM_EXPORT'})).ok).toBe(true);
    const conflicted=(await call('finance.profitability',{accountId,periodStart,periodEnd:at})).result as any;
    expect(conflicted.listings.find((l:any)=>l.id==='profit-negative')).toMatchObject({profitCents:null,status:'CONFLICT'});
  });

  it('estoque distingue zero de ausência, calcula cobertura apenas com janela explícita e preserva conta',async()=>{
    const accountId='acct-inventory-5';seedImportAccount(accountId);seedImportAccount('acct-inventory-other-5');
    const at=new Date().toISOString();
    for(const id of ['inventory-zero','inventory-known','inventory-unknown'])db.db.prepare('INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,accountId,'mercado_livre',id,id,'ACTIVE',at,at);
    const insert=db.db.prepare('INSERT INTO listing_snapshots (id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class,evidence_json) VALUES (?,?,?,?,?,?,?,?)');
    const evidence=JSON.stringify({filtersAndPeriod:'start_date=2025-01-01|end_date=2025-01-07'});
    insert.run('inv-s1','inventory-zero',accountId,at,at,JSON.stringify({stockAvailable:0,units:7,adSpend:20,questionsPending:2}),'A_PRIMARY_UI',evidence);
    insert.run('inv-s2','inventory-known',accountId,at,at,JSON.stringify({stockAvailable:14,units:7}),'A_PRIMARY_UI',evidence);
    const result=(await call('inventory.dashboard',{accountId,days:30})).result as any;
    expect(result.items.find((l:any)=>l.id==='inventory-zero')).toMatchObject({stock:0,coverageDays:0,signals:expect.arrayContaining(['OUT_OF_STOCK','LOW_COVERAGE','ADS_SPEND_WITH_ZERO_STOCK_OBSERVED','PENDING_QUESTIONS'])});
    expect(result.items.find((l:any)=>l.id==='inventory-known')).toMatchObject({coverageDays:14,signals:[]});
    expect(result.items.find((l:any)=>l.id==='inventory-unknown')).toMatchObject({stock:null,coverageDays:null,signals:[]});
    expect((await call('inventory.dashboard',{accountId:'acct-inventory-other-5'})).result).toMatchObject({items:[]});
  });

  it('Ads limita escopo, não duplica campanha e calcula TACoS somente com janelas compatíveis',async()=>{
    const accountId='acct-ads-5';seedImportAccount(accountId);
    const at='2025-01-08T12:00:00.000Z',from='2025-01-08T00:00:00.000Z',to='2025-01-08T23:59:59.999Z';
    const evidence={filtersAndPeriod:'start_date=2025-01-01|end_date=2025-01-07|status=all'};
    const base={marketplace:'mercado_livre',accountId,sourceClass:'A_PRIMARY_UI',referenceAt:at,collectedAt:at,method:'content_script_dom',listings:[],evidence};
    const detail={kind:'AD_CAMPAIGN',externalId:'C5',metrics:{adSpend:100,adAttributedRevenue:0},evidence:{adSpend:'Investimento',adAttributedRevenue:'Receita atribuída'}};
    expect((await call('capture.ingest',{...base,pageKind:'seller_ads',url:'https://vendedores.mercadolivre.com.br/publicidade',accountMetrics:{adSpend:100},details:[detail]})).ok).toBe(true);
    expect((await call('capture.ingest',{...base,pageKind:'seller_dashboard',url:'https://vendedores.mercadolivre.com.br/vendas',accountMetrics:{gmv:1000}})).ok).toBe(true);
    const result=(await call('ads.dashboard',{accountId,from,to})).result as any;
    expect(result).toMatchObject({tacosPct:10,items:[{external_id:'C5',signal:'REVIEW_SPEND',verified:true}]});
    const costs={productCostCents:15000,packagingCents:0,shippingCents:0,marketplaceFeesCents:0,taxesCents:0,refundsCents:0,returnLogisticsCents:0,cancellationLossCents:0,otherCostsCents:0};
    const rec={accountId,snapshotId:result.items[0].id,netAttributedRevenueCents:20000,costs,sourceReference:'Relatório conciliado de campanha',confirmedSameScope:true};
    expect((await call('ads.reconcile',{...rec,costs:{productCostCents:15000}})).ok).toBe(false);
    expect((await call('ads.reconcile',rec)).result).toMatchObject({profitCents:-5000,classification:'REPORTED_ATTRIBUTED_PROFIT'});
    expect((await call('ads.dashboard',{accountId,from,to})).result).toMatchObject({items:[{profitCents:-5000,signal:'REPORTED_NEGATIVE_ATTRIBUTED_PROFIT'}]});

    expect((await call('ads.dashboard',{accountId,from,to,externalId:'C5'})).result).toMatchObject({tacosPct:null});
    db.db.prepare("UPDATE account_snapshots SET evidence_json=? WHERE account_id=? AND page_kind='seller_dashboard'").run(JSON.stringify({filtersAndPeriod:'start_date=2025-01-02|end_date=2025-01-07|status=all'}),accountId);
    expect((await call('ads.dashboard',{accountId,from,to})).result).toMatchObject({tacosPct:null});
  });


  it('orçamento diário autorizado exige baseline, conta e documento novos, sem repetição',async()=>{
    const accountId='acct-budget-5',other='acct-budget-other-5';seedImportAccount(accountId);seedImportAccount(other);
    const campaignRef='C-BUDGET',proposal=(await call('campaign.change.prepare',{accountId,marketplace:'mercado_livre',campaignRef,baseline:{dailyBudgetCents:1000},changes:{dailyBudgetCents:1200},reason:'Teste orçamento'})).result as any;
    const ctx={accountId,campaignRef,sourcePath:'https://vendedores.mercadolivre.com.br/publicidade',documentNonce:'11111111-1111-4111-8111-111111111111',budgetCents:1000,proposalId:proposal.id};
    expect((await call('campaign.budget.claim',{...ctx,confirmed:true})).ok).toBe(false);
    expect((await call('campaign.change.review',{accountId,proposalId:proposal.id,decision:'APPROVED',reason:'Teste'})).ok).toBe(true);
    for(const bad of [{accountId:other},{budgetCents:999},{sourcePath:'https://www.mercadolivre.com.br/publicidade'},{sourcePath:'https://vendedores.mercadolivre.com.br/publicidade?token=abc'},{campaignRef:'OTHER'},{confirmed:false}]){
      expect((await call('campaign.budget.claim',{...ctx,confirmed:true,...bad})).ok).toBe(false);
    }
    expect((await call('campaign.budget.claim',{...ctx,confirmed:true})).ok).toBe(false);
    const limits={maxCampaignDailyBudgetCents:1100,minVariationPriceCents:100,maxVariationPriceCents:100000,maxVariationStock:100,maxVariationPriceChangePct:20};
    expect((await call('operation.limits.set',{accountId,limits,confirmed:true})).ok).toBe(true);
    expect((await call('campaign.budget.claim',{...ctx,confirmed:true})).ok).toBe(false);
    expect((await call('operation.limits.set',{accountId,limits:{...limits,maxCampaignDailyBudgetCents:1500},confirmed:true})).ok).toBe(true);
    const claim=await call('campaign.budget.claim',{...ctx,confirmed:true});
    expect(claim.ok).toBe(true);
    const grant=claim.result as any;
    expect(grant).toMatchObject({beforeCents:1000,targetCents:1200,accountId,campaignRef});
    expect((await call('campaign.budget.claim',{...ctx,confirmed:true})).ok).toBe(false);
    expect((await call('campaign.budget.result',{id:grant.id,token:'22222222-2222-4222-8222-222222222222',outcome:'NEEDS_VERIFICATION',message:'Teste'})).ok).toBe(false);
    expect((await call('campaign.budget.result',{id:grant.id,token:grant.token,outcome:'NEEDS_VERIFICATION',message:'Teste'})).ok).toBe(true);
    expect((await call('campaign.budget.result',{id:grant.id,token:grant.token,outcome:'NEEDS_VERIFICATION',message:'Teste'})).ok).toBe(false);
    expect((await call('campaign.budget.verify',{...ctx,budgetCents:1200})).ok).toBe(false);
    const reload={...ctx,documentNonce:'33333333-3333-4333-8333-333333333333'};
    expect((await call('campaign.budget.verify',{...reload,budgetCents:999})).result).toMatchObject({status:'NEEDS_VERIFICATION',remoteVerified:false});
    expect((await call('campaign.budget.verify',{...reload,budgetCents:1200})).result).toMatchObject({status:'UI_READBACK_MATCHED',remoteVerified:false,uiReadbackMatched:true});
    expect((await call('campaign.budget.verify',{...reload,budgetCents:1200})).ok).toBe(false);
    const measure={accountId,proposalKind:'CAMPAIGN',proposalId:proposal.id};
    expect((await call('operation.measure',{...measure,accountId:other})).result).toMatchObject({status:'EXECUTION_EVIDENCE_REQUIRED'});
    db.db.prepare('UPDATE campaign_budget_executions SET created_at=?,updated_at=? WHERE id=?')
      .run('2025-01-08T12:00:00.000Z','2025-01-09T12:00:00.000Z',grant.id);
    const capture=async (from:string,to:string,at:string,adClicks:number,coverageWarnings?:string)=>{
      const response=await call('capture.ingest',{accountId,marketplace:'mercado_livre',url:ctx.sourcePath,
        pageKind:'seller_ads',sourceClass:'A_PRIMARY_UI',referenceAt:at,collectedAt:at,method:'content_script_dom',listings:[],
        evidence:{filtersAndPeriod:`start_date=${from}|end_date=${to}|status=all`,...(coverageWarnings?{coverageWarnings}:{})},
        details:[{kind:'AD_CAMPAIGN',externalId:campaignRef,metrics:{adClicks},evidence:{adClicks:`Cliques: ${adClicks}`}}],
      });
      expect(response.ok).toBe(true);
    };
    await capture('2025-01-01','2025-01-07','2025-01-08T10:00:00.000Z',10);
    await capture('2025-01-09','2025-01-15','2025-01-16T10:00:00.000Z',99);
    expect((await call('operation.measure',measure)).result).toMatchObject({status:'INSUFFICIENT_COMPATIBLE_WINDOWS'});
    await capture('2025-01-10','2025-01-16','2025-01-17T10:00:00.000Z',12);
    await capture('2025-01-11','2025-01-17','2025-01-18T10:00:00.000Z',99,'COBERTURA_PARCIAL');
    expect((await call('operation.measure',measure)).result).toMatchObject({
      status:'OBSERVED_CHANGE',executionEvidence:'UI_READBACK_MATCHED',measurementScope:'CAMPAIGN',
      metrics:{adClicks:{before:10,after:12,delta:2}},remoteVerified:false,causalityVerified:false,
    });
    const items=(await call('campaign.budget.list',{accountId})).result as any[];
    expect(items).toHaveLength(1);expect(items[0].status).toBe('UI_READBACK_MATCHED');expect(items[0].token_hash).toBeUndefined();
    expect((await call('campaign.budget.list',{accountId:other})).result).toEqual([]);
  });

  it('autoriza pausa de campanha com orçamento constante e exige estado posterior em outro documento',async()=>{
    const accountId='campaign-status-account',campaignRef='P-1';
    seedImportAccount(accountId);
    const budget={dailyBudgetCents:1000};
    const proposal=(await call('campaign.change.prepare',{accountId,marketplace:'mercado_livre',campaignRef,
      baseline:{...budget,status:'ACTIVE'},changes:{...budget,status:'PAUSED'},reason:'Pausar campanha aprovada'})).result as {id:string};
    expect((await call('campaign.change.review',{accountId,proposalId:proposal.id,decision:'APPROVED',reason:'Teste'})).ok).toBe(true);
    const limit={minVariationPriceCents:100,maxVariationPriceCents:10000,maxVariationStock:50,maxVariationPriceChangePct:20};
    const ctx={accountId,campaignRef,proposalId:proposal.id,sourcePath:'https://vendedores.mercadolivre.com.br/publicidade',
      documentNonce:'11111111-1111-4111-8111-111111111111',budgetCents:1000,campaignStatus:'ACTIVE',confirmed:true};
    expect((await call('operation.limits.set',{accountId,limits:{...limit,maxCampaignDailyBudgetCents:900},confirmed:true})).ok).toBe(true);
    expect((await call('campaign.budget.claim',ctx)).ok).toBe(false);
    expect((await call('operation.limits.set',{accountId,limits:{...limit,maxCampaignDailyBudgetCents:1200},confirmed:true})).ok).toBe(true);
    expect((await call('campaign.budget.claim',{...ctx,campaignStatus:undefined})).ok).toBe(false);
    const claimed=await call('campaign.budget.claim',ctx);
    expect(claimed.ok).toBe(true);
    const grant=claimed.result as {id:string;token:string};
    expect(grant).toMatchObject({beforeStatus:'ACTIVE',targetStatus:'PAUSED',beforeCents:1000,targetCents:1000});
    expect((await call('campaign.budget.result',{id:grant.id,token:grant.token,outcome:'NEEDS_VERIFICATION',message:'Clique autorizado'})).ok).toBe(true);
    const {confirmed,...verified}=ctx;
    expect((await call('campaign.budget.verify',{...verified,campaignStatus:'PAUSED'})).ok).toBe(false);
    const fresh={...verified,documentNonce:'22222222-2222-4222-8222-222222222222'};
    expect((await call('campaign.budget.verify',fresh)).result).toMatchObject({status:'NEEDS_VERIFICATION'});
    expect((await call('campaign.budget.verify',{...fresh,campaignStatus:'PAUSED',budgetCents:1001})).result).toMatchObject({status:'NEEDS_VERIFICATION'});
    expect((await call('campaign.budget.verify',{...fresh,campaignStatus:'PAUSED'})).result).toMatchObject({status:'UI_READBACK_MATCHED',remoteVerified:false});
  });

  it('autoriza meta ROAS com orçamento constante e exige releitura correspondente',async()=>{
    const accountId='campaign-roas-shop',campaignRef='C-ROAS';seedImportAccount(accountId);
    const base={dailyBudgetCents:1000,roasTargetHundredths:500};
    const proposal=(await call('campaign.change.prepare',{accountId,marketplace:'mercado_livre',campaignRef,baseline:base,changes:{...base,roasTargetHundredths:650},reason:'Alteração de ROAS aprovada'})).result as {id:string};
    expect((await call('campaign.change.review',{accountId,proposalId:proposal.id,decision:'APPROVED',reason:'Teste'})).ok).toBe(true);
    expect((await call('operation.limits.set',{accountId,confirmed:true,limits:{maxCampaignDailyBudgetCents:1200,minVariationPriceCents:100,maxVariationPriceCents:10000,maxVariationStock:50,maxVariationPriceChangePct:20}})).ok).toBe(true);
    const ctx={accountId,campaignRef,proposalId:proposal.id,sourcePath:'https://vendedores.mercadolivre.com.br/publicidade',
      documentNonce:'11111111-1111-4111-8111-111111111111',budgetCents:1000,roasTargetHundredths:500,confirmed:true};
    expect((await call('campaign.budget.claim',{...ctx,roasTargetHundredths:501})).ok).toBe(false);
    const grant=(await call('campaign.budget.claim',ctx)).result as {id:string;token:string};
    expect(grant).toMatchObject({beforeRoas:500,targetRoas:650,beforeCents:1000,targetCents:1000});
    expect((await call('campaign.budget.result',{id:grant.id,token:grant.token,outcome:'NEEDS_VERIFICATION',message:'Clique autorizado'})).ok).toBe(true);
    const {confirmed,...verified}=ctx;
    expect((await call('campaign.budget.verify',{...verified,roasTargetHundredths:650})).ok).toBe(false);
    const fresh={...verified,documentNonce:'22222222-2222-4222-8222-222222222222',roasTargetHundredths:650};
    expect((await call('campaign.budget.verify',{...fresh,budgetCents:1001})).result).toMatchObject({status:'NEEDS_VERIFICATION'});
    expect((await call('campaign.budget.verify',fresh)).result).toMatchObject({status:'UI_READBACK_MATCHED'});
  });

  it('cria variação legada pela API com loja validada, ID retornado e conferência independente',async()=>{
    const accountId='api-variant-shop',itemId='MLB1234567',listingId='api-item',at='2025-01-01T00:00:00.000Z';
    seedImportAccount(accountId);
    db.db.prepare('INSERT INTO listings(id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(listingId,accountId,'mercado_livre',itemId,'Anúncio','ACTIVE',at,at);
    const option={attributeCombinations:[{id:'COLOR',value_id:'2'}],pictureIds:['PIC1']};
    const draft=(await call('offer.variation.prepare',{accountId,listingId,variationName:'Azul',options:[option],proposedPriceCents:1200,proposedStock:0})).result as {id:string};
    expect((await call('offer.variation.review',{accountId,id:draft.id,decision:'APPROVED',reason:'Teste de revisão'})).ok).toBe(true);
    expect((await call('operation.limits.set',{accountId,confirmed:true,limits:{
      maxCampaignDailyBudgetCents:2000,minVariationPriceCents:500,maxVariationPriceCents:2000,maxVariationStock:10,maxVariationPriceChangePct:20,
    }})).ok).toBe(true);
    const request={accountId,proposalId:draft.id,accessToken:'fixture-token-local',confirmed:true};
    let nickname='outra loja',created=false,postCount=0,failReadback=true,deleted=false,sold=0,deleteCount=0,hideCreated=false,sellerId=23,remoteStock=0,putCount=0;
    const mock=vi.fn(async (url:URL,init:RequestInit)=>{
      expect(url.origin).toBe('https://api.mercadolibre.com');
      expect(init.redirect).toBe('error');
      if(url.pathname==='/users/me')return Response.json({id:23,nickname,site_id:'MLB',tags:[]});
      if(url.pathname==='/items/'+itemId&&init.method==='PUT'){
        putCount++;
        const body=JSON.parse(String(init.body));
        expect(body.variations).toEqual([{id:'41'},{id:'42',available_quantity:3}]);
        remoteStock=3;return Response.json({id:itemId});
      }
      if(url.pathname==='/items/'+itemId)return Response.json({id:itemId,seller_id:sellerId,site_id:'MLB',currency_id:'BRL',status:'active',
        user_product_id:null,pictures:[{id:'PIC1'}],variations:[{id:41,attribute_combinations:[{id:'COLOR',value_id:'1'}]},
          ...(created&&!deleted&&!hideCreated?[{id:42,attribute_combinations:option.attributeCombinations,price:12,available_quantity:remoteStock,sold_quantity:sold}]:[])]});
      if(url.pathname==='/items/'+itemId+'/variations'&&init.method==='POST'){
        postCount++;
        expect(JSON.parse(String(init.body))).toEqual({attribute_combinations:option.attributeCombinations,price:12,available_quantity:0,sold_quantity:0,picture_ids:['PIC1']});
        created=true;return Response.json({id:42},{status:201});
      }
      if(url.pathname==='/items/'+itemId+'/variations/42'){
        if(init.method==='DELETE'){deleteCount++;deleted=true;return new Response(null,{status:204});}
        if(failReadback)throw Error('timeout simulado');
        return Response.json({id:42,price:12,available_quantity:remoteStock,picture_ids:['PIC1'],attribute_combinations:option.attributeCombinations});
      }
      throw Error('rota inesperada');
    });
    vi.stubGlobal('fetch',mock);
    try{
      expect((await call('variation.api.create',request)).ok).toBe(false);
      expect(postCount).toBe(0);
      nickname=accountId;
      const results=await Promise.all([call('variation.api.create',request),call('variation.api.create',request)]);
      expect(results.filter(r=>r.ok)).toHaveLength(1);
      expect(results.find(r=>r.ok)?.result).toMatchObject({status:'NEEDS_VERIFICATION',variationId:'42',remoteVerified:false});
      expect(postCount).toBe(1);
      failReadback=false;
      const {confirmed,...verify}=request;
      hideCreated=true;
      expect((await call('variation.api.verify',verify)).result).toMatchObject({status:'NEEDS_VERIFICATION',variationId:'42',remoteVerified:false});
      hideCreated=false;
      sellerId=24;
      expect((await call('variation.api.verify',verify)).ok).toBe(false);
      sellerId=23;
      expect((await call('variation.api.verify',verify)).result).toMatchObject({status:'REMOTE_VERIFIED',variationId:'42',remoteVerified:true});
      expect(postCount).toBe(1);
      const list=await call('variation.api.list',{accountId});
      expect(list.result).toMatchObject([{proposal_id:draft.id,variation_id:'42',status:'REMOTE_VERIFIED'}]);
      expect((await call('operation.measure',{accountId,proposalId:draft.id,proposalKind:'VARIATION'})).result).toMatchObject({
        status:'API_VARIATION_CONFIRMED',remoteVerified:true,causalityVerified:false,
        createdVariation:{externalId:'42',priceCents:1200,stock:0},
      });
      expect(JSON.stringify(list.result)).not.toContain(request.accessToken);
      const edit=(await call('offer.variation.prepare',{accountId,listingId,variationName:'Editar estoque Azul',
        options:[{editVariationId:'42',beforePriceCents:1200,beforeStock:0}],proposedPriceCents:1200,proposedStock:3})).result as {id:string};
      expect((await call('offer.variation.review',{accountId,id:edit.id,decision:'APPROVED',reason:'Edição autorizada'})).ok).toBe(true);
      const editRequest={...request,proposalId:edit.id};
      remoteStock=1;
      expect((await call('variation.api.editStock',editRequest)).ok).toBe(false);
      expect(putCount).toBe(0);
      remoteStock=0;
      expect((await call('variation.api.editStock',editRequest)).result).toMatchObject({status:'REMOTE_VERIFIED',action:'EDIT_VARIATION',variationId:'42'});
      expect((await call('variation.api.editStock',editRequest)).ok).toBe(false);
      expect(putCount).toBe(1);
      expect((await call('operation.measure',{accountId,proposalId:edit.id,proposalKind:'VARIATION'})).result).toMatchObject({
        status:'API_VARIATION_STOCK_CONFIRMED',editedVariation:{externalId:'42',beforeStock:0,stock:3,priceCents:1200},
      });
      db.db.prepare("UPDATE listing_api_executions SET started_at=?,updated_at=? WHERE proposal_id=?").run('2025-01-08T12:00:00.000Z','2025-01-08T13:00:00.000Z',edit.id);
      const insertMetric=db.db.prepare('INSERT INTO listing_snapshots(id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class,evidence_json) VALUES(?,?,?,?,?,?,?,?)');
      insertMetric.run('api-before',listingId,accountId,'2025-01-07T23:59:59.999Z','2025-01-07T23:59:59.999Z',JSON.stringify({orders:10}),'A_PRIMARY_UI',JSON.stringify({filtersAndPeriod:'start_date=2025-01-01|end_date=2025-01-07|status=all'}));
      expect((await call('operation.measure',{accountId,proposalId:edit.id,proposalKind:'VARIATION'})).result).toMatchObject({measurementStatus:'INSUFFICIENT_COMPATIBLE_WINDOWS',remoteVerified:true,metrics:null});
      insertMetric.run('api-after',listingId,accountId,'2025-01-16T12:00:00.000Z','2025-01-16T12:00:00.000Z',JSON.stringify({orders:12}),'A_PRIMARY_UI',JSON.stringify({filtersAndPeriod:'start_date=2025-01-09|end_date=2025-01-15|status=all'}));
      expect((await call('operation.measure',{accountId,proposalId:edit.id,proposalKind:'VARIATION'})).result).toMatchObject({status:'API_VARIATION_STOCK_CONFIRMED',measurementStatus:'OBSERVED_CHANGE',measurementScope:'LISTING',metrics:{orders:{before:10,after:12,deltaPct:20}},remoteVerified:true,causalityVerified:false});
      remoteStock=0;
      const removal=(await call('offer.variation.prepare',{accountId,listingId,variationName:'Remover Azul',
        options:[{removeVariationId:'42'}],proposedPriceCents:1200,proposedStock:0})).result as {id:string};
      expect((await call('offer.variation.review',{accountId,id:removal.id,decision:'APPROVED',reason:'Remoção autorizada'})).ok).toBe(true);
      const remove={...request,proposalId:removal.id};
      sold=1;
      expect((await call('variation.api.remove',remove)).ok).toBe(false);
      expect(deleteCount).toBe(0);
      sold=0;
      expect((await call('variation.api.remove',remove)).result).toMatchObject({status:'REMOTE_VERIFIED',action:'REMOVE_VARIATION',variationId:'42'});
      expect((await call('variation.api.remove',remove)).ok).toBe(false);
      expect(deleteCount).toBe(1);
      expect((await call('operation.measure',{accountId,proposalId:removal.id,proposalKind:'VARIATION'})).result).toMatchObject({
        status:'API_VARIATION_REMOVAL_CONFIRMED',removedVariation:{externalId:'42'},
      });

    }finally{
      vi.unstubAllGlobals();
    }
  });

  it('cria condição de venda User Products sem duplicar estoque ou aceitar oferta de outra loja',async()=>{
    const accountId='api-up-shop',itemId='MLB1234567',newId='MLB1234568',listingId='api-up-item',upId='MLBU1234567',at='2025-01-01T00:00:00.000Z';
    seedImportAccount(accountId);
    db.db.prepare('INSERT INTO listings(id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(listingId,accountId,'mercado_livre',itemId,'Anúncio UP','ACTIVE',at,at);
    const option={userProductId:upId,categoryId:'MLB1234',listingTypeId:'gold_pro',beforePriceCents:1000,beforeStock:3};
    const draft=(await call('offer.variation.prepare',{accountId,listingId,variationName:'Oferta premium',options:[option],proposedPriceCents:1200,proposedStock:3})).result as {id:string};
    expect((await call('offer.variation.review',{accountId,id:draft.id,decision:'APPROVED',reason:'Teste'})).ok).toBe(true);
    expect((await call('operation.limits.set',{accountId,confirmed:true,limits:{maxCampaignDailyBudgetCents:2000,minVariationPriceCents:500,maxVariationPriceCents:2000,maxVariationStock:10,maxVariationPriceChangePct:20}})).ok).toBe(true);
    let owner=24,created=false,posts=0,readback=false,total=1;
    const source={id:itemId,seller_id:23,site_id:'MLB',currency_id:'BRL',user_product_id:upId,category_id:'MLB1234',listing_type_id:'gold_special',buying_mode:'buy_it_now',condition:'new',catalog_listing:false,price:10,available_quantity:3,status:'active',variations:[],channels:['marketplace']};
    vi.stubGlobal('fetch',vi.fn(async(url:URL,init:RequestInit)=>{
      if(url.pathname==='/users/me')return Response.json({id:23,nickname:accountId,site_id:'MLB',tags:['user_product_seller']});
      if(url.pathname==='/items/'+itemId)return Response.json(source);
      if(url.pathname==='/user-products/'+upId)return Response.json({id:upId,user_id:owner,site_id:'MLB'});
      if(url.pathname==='/users/23/items/search')return Response.json({seller_id:23,results:[itemId],paging:{offset:0,total}});
      if(url.pathname==='/user-products/'+upId+'/items'&&init.method==='POST'){
        posts++;expect(JSON.parse(String(init.body))).toEqual({price:12,category_id:'MLB1234',currency_id:'BRL',buying_mode:'buy_it_now',listing_type_id:'gold_pro',channels:['marketplace'],catalog_listing:false});
        created=true;return Response.json({id:newId},{status:201});
      }
      if(url.pathname==='/items/'+newId&&created)return Response.json({...source,id:newId,price:12,listing_type_id:'gold_pro',seller_id:readback?23:24});
      throw Error('rota inesperada');
    }));
    try{
      const request={accountId,proposalId:draft.id,accessToken:'fixture-token-local',confirmed:true};
      expect((await call('variation.api.createUpOffer',request)).ok).toBe(false);expect(posts).toBe(0);
      owner=23;total=51;
      expect((await call('variation.api.createUpOffer',request)).ok).toBe(false);expect(posts).toBe(0);
      total=1;
      const results=await Promise.all([call('variation.api.createUpOffer',request),call('variation.api.createUpOffer',request)]);
      expect(results.filter(r=>r.ok)).toHaveLength(1);expect(posts).toBe(1);
      expect(results.find(r=>r.ok)?.result).toMatchObject({status:'NEEDS_VERIFICATION',variationId:newId,action:'CREATE_UP_OFFER'});
      const {confirmed,...verify}=request;readback=true;
      expect((await call('variation.api.verify',verify)).result).toMatchObject({status:'REMOTE_VERIFIED',variationId:newId});
      expect((await call('operation.measure',{accountId,proposalId:draft.id,proposalKind:'VARIATION'})).result).toMatchObject({status:'API_UP_OFFER_CONFIRMED',measurementScope:'USER_PRODUCT_ORIGINAL_VS_OFFER',createdOffer:{externalId:newId,stock:3},metrics:null,causalityVerified:false});
      const again=(await call('offer.variation.prepare',{accountId,listingId,variationName:'Outra proposta da mesma oferta',options:[option],proposedPriceCents:1200,proposedStock:3})).result as {id:string};
      expect((await call('offer.variation.review',{accountId,id:again.id,decision:'APPROVED',reason:'Teste'})).ok).toBe(true);
      expect((await call('variation.api.createUpOffer',{...request,proposalId:again.id})).ok).toBe(false);
      expect(posts).toBe(1);
    }finally{vi.unstubAllGlobals();}
  });

  it('autoriza variação simples e duplicação apenas com proposta, contexto e limites correspondentes',async()=>{
    const accountId='acct-browser-listing',other='acct-browser-other';seedImportAccount(accountId);seedImportAccount(other);
    const listingId='browser-listing',externalListingId='MLB1234567',at='2025-01-07T23:59:59.999Z';
    db.db.prepare('INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(listingId,accountId,'mercado_livre',externalListingId,'Teste','ACTIVE',at,at);
    db.db.prepare('INSERT INTO listing_snapshots (id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class,evidence_json) VALUES (?,?,?,?,?,?,?,?)').run('browser-baseline',listingId,accountId,at,at,'{}','A_PRIMARY_UI','{}');
    const proposal=(await call('offer.variation.prepare',{accountId,listingId,variationName:'Cor',options:[{name:'Azul'}],proposedPriceCents:1200,proposedStock:5})).result as any;
    expect((await call('offer.variation.review',{accountId,id:proposal.id,decision:'APPROVED',reason:'Teste'})).ok).toBe(true);
    const ctx={accountId,externalListingId,action:'CREATE_VARIATION',sourcePath:'https://vendedores.mercadolivre.com.br/vendas/anuncios/editar/MLB1234567',documentNonce:'11111111-1111-4111-8111-111111111111',proposalId:proposal.id,confirmed:true};
    expect((await call('listing.browser.claim',ctx)).ok).toBe(false);
    const limits={maxCampaignDailyBudgetCents:1500,minVariationPriceCents:100,maxVariationPriceCents:100000,maxVariationStock:100,maxVariationPriceChangePct:20};
    expect((await call('operation.limits.set',{accountId,limits,confirmed:true})).ok).toBe(true);
    for(const bad of [{accountId:other},{externalListingId:'MLB7654321'},{action:'EDIT_VARIATION'},{confirmed:false},{sourcePath:'https://www.mercadolivre.com.br/vendas/anuncios/editar/MLB1234567'}]){
      expect((await call('listing.browser.claim',{...ctx,...bad})).ok).toBe(false);
    }
    const claim=await call('listing.browser.claim',ctx);expect(claim.ok).toBe(true);
    const grant=claim.result as any;expect(grant.plan).toEqual({name:'Cor',option:'Azul',priceCents:1200,stock:5});
    expect((await call('listing.browser.claim',ctx)).ok).toBe(false);
    expect((await call('listing.browser.result',{id:grant.id,token:grant.token,outcome:'NEEDS_VERIFICATION',message:'Teste'})).ok).toBe(true);
    expect((await call('listing.browser.verify',{accountId,proposalId:proposal.id,observedExternalId:'V1'})).ok).toBe(false);
    expect((await call('listing.browser.list',{accountId:other})).result).toEqual([]);
    const duplicate=(await call('listing.change.prepare',{accountId,listingId,kind:'DUPLICATE',reason:'Teste duplicação'})).result as any;
    expect((await call('listing.change.review',{accountId,id:duplicate.id,decision:'APPROVED',reason:'Teste'})).ok).toBe(true);
    const duplicateCtx={...ctx,proposalId:duplicate.id,action:'DUPLICATE',sourcePath:'https://vendedores.mercadolivre.com.br/vendas/anuncios'};
    expect((await call('listing.browser.claim',duplicateCtx)).ok).toBe(false);
    db.db.prepare("UPDATE listing_browser_executions SET status='CANDIDATE_OBSERVED' WHERE id=?").run(grant.id);
    const duplication=await call('listing.browser.claim',duplicateCtx);expect(duplication.ok).toBe(true);
    expect((duplication.result as any).plan).toEqual({originalTitle:'Teste'});
    const d=(duplication.result as any);
    expect((await call('listing.browser.result',{id:d.id,token:d.token,outcome:'NEEDS_VERIFICATION',message:'Teste',duplicateReceipt:'Anúncio MLB1234567 duplicado com sucesso. Novo anúncio: MLB9876543'})).ok).toBe(true);
    expect((await call('listing.browser.verify',{accountId,proposalId:duplicate.id,observedExternalId:externalListingId})).ok).toBe(false);
    db.db.prepare("UPDATE listing_browser_executions SET created_at=?,updated_at=? WHERE id=?").run('2025-01-08T12:00:00.000Z','2025-01-08T13:00:00.000Z',d.id);
    const insertCopy=db.db.prepare('INSERT INTO listings(id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
    const insertSnap=db.db.prepare('INSERT INTO listing_snapshots(id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class,evidence_json) VALUES(?,?,?,?,?,?,?,?)');
    const captured='2025-01-16T12:00:00.000Z';
    insertCopy.run('wrong-copy',accountId,'mercado_livre','MLB8888888','Teste','ACTIVE',captured,captured);
    insertSnap.run('wrong-copy-snap','wrong-copy',accountId,captured,captured,'{}','A_PRIMARY_UI','{}');
    expect((await call('listing.browser.verify',{accountId,proposalId:duplicate.id,observedExternalId:'MLB8888888'})).ok).toBe(false);
    insertCopy.run('right-copy',accountId,'mercado_livre','MLB9876543','Teste','ACTIVE',captured,captured);
    insertSnap.run('right-copy-snap','right-copy',accountId,captured,captured,JSON.stringify({orders:12}),'A_PRIMARY_UI',JSON.stringify({filtersAndPeriod:'start_date=2025-01-09|end_date=2025-01-15|status=all'}));
    expect((await call('listing.browser.verify',{accountId,proposalId:duplicate.id,observedExternalId:'MLB9876543'})).result).toMatchObject({status:'UI_READBACK_MATCHED',duplicateOriginObserved:true,remoteVerified:false});
    db.db.prepare("UPDATE listing_browser_executions SET updated_at=? WHERE id=?").run('2025-01-08T13:00:00.000Z',d.id);
    db.db.prepare("UPDATE listing_snapshots SET metrics_json=?,evidence_json=? WHERE id=?").run(JSON.stringify({orders:10}),JSON.stringify({filtersAndPeriod:'start_date=2025-01-01|end_date=2025-01-07|status=all'}),'browser-baseline');
    expect((await call('operation.measure',{accountId,proposalKind:'LISTING_CHANGE',proposalId:duplicate.id})).result).toMatchObject({status:'DUPLICATE_STATE_CONFIRMED',measurementStatus:'OBSERVED_CHANGE',measurementScope:'DUPLICATE_ORIGINAL_VS_COPY',metrics:{orders:{before:10,after:12,deltaPct:20}},remoteVerified:false,causalityVerified:false});
    const rows=(await call('listing.browser.list',{accountId})).result as any[];
    expect(rows).toHaveLength(2);expect(rows.every(row=>row.token_hash===undefined)).toBe(true);
  });

  it('confere relatos de variação e duplicação com capturas posteriores da mesma loja',async()=>{
    const accountId='receipt-shop',other='receipt-other';
    seedImportAccount(accountId);seedImportAccount(other);
    const before='2025-01-07T12:00:00.000Z',performedAt='2025-01-08T12:00:00.000Z',after='2025-01-09T12:00:00.000Z';
    const parent='MLB1234567',listingId='receipt-original';
    const insertListing=db.db.prepare('INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
    insertListing.run(listingId,accountId,'mercado_livre',parent,'Produto','ACTIVE',before,before);
    const prepared=(await call('offer.variation.prepare',{accountId,listingId,variationName:'Azul',options:[{externalId:'V1',beforePriceCents:1000,beforeStock:2}],proposedPriceCents:1200,proposedStock:5})).result as {id:string};
    expect((await call('offer.variation.review',{accountId,id:prepared.id,decision:'APPROVED',reason:'Teste de revisão'})).ok).toBe(true);
    db.db.prepare('UPDATE offer_variation_proposals SET updated_at=? WHERE id=?').run(before,prepared.id);
    const receipt={accountId,proposalKind:'VARIATION',proposalId:prepared.id,performedAt,evidenceReference:'Relatório do vendedor',confirmedManualExecution:true};
    expect((await call('operation.receipt.record',receipt)).ok).toBe(true);
    const verify={accountId,proposalKind:'VARIATION',proposalId:prepared.id,observedExternalId:'V1'};
    const capture=(shop:string,externalId:string,parentExternalId:string,at:string,price:number,stockAvailable:number)=>call('capture.ingest',{
      marketplace:'mercado_livre',accountId:shop,pageKind:'seller_listings',url:'https://vendedores.mercadolivre.com.br/anuncios',
      sourceClass:'A_PRIMARY_UI',referenceAt:at,collectedAt:at,method:'content_script_dom',listings:[],
      details:[{kind:'LISTING_VARIANT',externalId,parentExternalId,label:'Azul',metrics:{price,stockAvailable},evidence:{price:'Preço: R$ '+price,stockAvailable:'Estoque: '+stockAvailable}}],
    });
    expect((await capture(accountId,'V1',parent,before,10,2)).ok).toBe(true);
    expect((await capture(other,'V1',parent,after,12,5)).ok).toBe(true);
    expect((await capture(accountId,'V1','MLB7654321',after,12,5)).ok).toBe(true);
    expect((await call('operation.receipt.verify',verify)).ok).toBe(false);
    expect((await capture(accountId,'V1',parent,after,12,5)).ok).toBe(true);
    expect((await call('operation.receipt.verify',{...verify,accountId:other})).ok).toBe(false);
    expect((await call('operation.receipt.verify',verify)).result).toMatchObject({status:'UI_READBACK_MATCHED',observedExternalId:'V1',remoteVerified:false});
    expect((await call('operation.receipt.verify',verify)).ok).toBe(false);
    expect((await call('operation.receipt.list',{accountId})).result).toMatchObject([{status:'HUMAN_REPORTED',observation:{status:'UI_READBACK_MATCHED'}}]);

    const measurement={accountId,proposalKind:'VARIATION',proposalId:prepared.id};
    expect((await call('operation.measure',measurement)).result).toMatchObject({
      status:'VARIATION_STATE_OBSERVED',metrics:null,remoteVerified:false,causalityVerified:false,
      variationObservation:{externalId:'V1',before:{priceCents:1000,stock:2},after:{priceCents:1200,stock:5}},
    });
    expect((await capture(accountId,'V1',parent,'2025-01-10T12:00:00.000Z',13,9)).ok).toBe(true);
    expect((await call('operation.measure',measurement)).result).toMatchObject({variationObservation:{after:{priceCents:1200,stock:5}}});

    db.db.prepare('INSERT INTO listing_snapshots (id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class,evidence_json) VALUES (?,?,?,?,?,?,?,?)').run('receipt-original-snapshot',listingId,accountId,before,before,'{}','A_PRIMARY_UI','{}');
    const duplicate=(await call('listing.change.prepare',{accountId,listingId,kind:'DUPLICATE',reason:'Teste de duplicação'})).result as {id:string};
    expect((await call('listing.change.review',{accountId,id:duplicate.id,decision:'APPROVED',reason:'Teste de revisão'})).ok).toBe(true);
    db.db.prepare('UPDATE listing_change_proposals SET updated_at=? WHERE id=?').run(before,duplicate.id);
    const duplication={...receipt,proposalKind:'LISTING_CHANGE',proposalId:duplicate.id};
    expect((await call('operation.receipt.record',duplication)).ok).toBe(true);
    expect((await call('operation.receipt.verify',{accountId,proposalKind:'LISTING_CHANGE',proposalId:duplicate.id,observedExternalId:parent})).ok).toBe(false);
    const copy='MLB3456789';
    expect((await call('capture.ingest',{marketplace:'mercado_livre',accountId,pageKind:'seller_listings',url:'https://vendedores.mercadolivre.com.br/anuncios',sourceClass:'A_PRIMARY_UI',referenceAt:after,collectedAt:after,method:'content_script_dom',listings:[{listingId:copy,title:'Produto',price:12}]})).ok).toBe(true);
    expect((await call('operation.receipt.verify',{accountId,proposalKind:'LISTING_CHANGE',proposalId:duplicate.id,observedExternalId:copy})).result).toMatchObject({status:'CANDIDATE_OBSERVED',observedExternalId:copy,remoteVerified:false});
    const second=(await call('listing.change.prepare',{accountId,listingId,kind:'DUPLICATE',reason:'Segunda proposta de duplicação'})).result as {id:string};
    expect((await call('listing.change.review',{accountId,id:second.id,decision:'APPROVED',reason:'Teste de revisão'})).ok).toBe(true);
    db.db.prepare('UPDATE listing_change_proposals SET updated_at=? WHERE id=?').run(before,second.id);
    expect((await call('operation.receipt.record',{...duplication,proposalId:second.id})).ok).toBe(true);
    expect((await call('operation.receipt.verify',{accountId,proposalKind:'LISTING_CHANGE',proposalId:second.id,observedExternalId:copy})).ok).toBe(false);
    const candidateMeasure={accountId,proposalKind:'LISTING_CHANGE',proposalId:duplicate.id};
    expect((await call('operation.measure',candidateMeasure)).result).toMatchObject({
      status:'CANDIDATE_STATE_OBSERVED',metrics:null,remoteVerified:false,causalityVerified:false,
      candidateObservation:{externalId:copy,priceCents:1200,stock:null},
    });
    expect((await call('operation.measure',{...candidateMeasure,accountId:other})).result)
      .toMatchObject({status:'EXECUTION_EVIDENCE_REQUIRED'});

  });

  it('persiste a captura exata antes e depois de uma edição assistida de variação',async()=>{
    const accountId='assisted-variation-edit';
    seedImportAccount(accountId);
    const listingId='assisted-variation-parent',externalListingId='MLB1234567',variationId='V1';
    const sourcePath='https://vendedores.mercadolivre.com.br/vendas/anuncios/editar/'+externalListingId;
    const capture=(at:string,price:number,stock:number,coverageWarnings?:string)=>call('capture.ingest',{
      accountId,marketplace:'mercado_livre',url:sourcePath,pageKind:'seller_listing_edit',sourceClass:'A_PRIMARY_UI',
      referenceAt:at,collectedAt:at,method:'content_script_dom',listings:[],
      evidence:coverageWarnings?{coverageWarnings}:{},
      details:[{kind:'LISTING_VARIANT',externalId:variationId,parentExternalId:externalListingId,label:'Azul',
        metrics:{price,stockAvailable:stock},evidence:{price:'Preço: '+price,stockAvailable:'Estoque: '+stock}}],
    });
    const at='2025-01-01T12:00:00.000Z';
    db.db.prepare('INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(listingId,accountId,'mercado_livre',externalListingId,'Anúncio','ACTIVE',at,at);
    const prepared=(await call('offer.variation.prepare',{accountId,listingId,variationName:'Azul',
      options:[{externalId:variationId,beforePriceCents:1000,beforeStock:3}],proposedPriceCents:1200,proposedStock:0})).result as {id:string};
    expect((await call('offer.variation.review',{accountId,id:prepared.id,decision:'APPROVED',reason:'Teste de revisão'})).ok).toBe(true);
    const limits={maxCampaignDailyBudgetCents:1500,minVariationPriceCents:100,maxVariationPriceCents:100000,maxVariationStock:100,maxVariationPriceChangePct:25};
    expect((await call('operation.limits.set',{accountId,limits,confirmed:true})).ok).toBe(true);
    const context={accountId,externalListingId,action:'EDIT_VARIATION',variationId,variationLabel:'Azul',beforePriceCents:1000,beforeStock:3,
      sourcePath,documentNonce:'11111111-1111-4111-8111-111111111111',proposalId:prepared.id,confirmed:true};
    expect((await capture(at,10,3,'COBERTURA_PARCIAL')).ok).toBe(true);
    expect((await call('listing.browser.claim',context)).ok).toBe(false);
    const baselineAt='2025-01-02T12:00:00.000Z';
    expect((await capture(baselineAt,10,3)).result).toMatchObject({detailRowsIngested:1});
    const claim=await call('listing.browser.claim',context);
    expect(claim.ok).toBe(true);
    const grant=claim.result as {id:string;token:string;plan:{baselineSnapshotId:string}};
    expect(grant.plan.baselineSnapshotId).toBeTruthy();
    expect((await call('listing.browser.result',{id:grant.id,token:grant.token,outcome:'NEEDS_VERIFICATION',message:'Salvamento acionado'})).ok).toBe(true);
    db.db.prepare('UPDATE listing_browser_executions SET created_at=?,updated_at=? WHERE id=?')
      .run('2025-01-04T12:00:00.000Z','2025-01-05T12:00:00.000Z',grant.id);
    expect((await capture('2025-01-03T12:00:00.000Z',9,8)).ok).toBe(true);
    const observedAt='2025-01-06T12:00:00.000Z';
    expect((await capture(observedAt,12,0)).result).toMatchObject({detailRowsIngested:1});
    expect((await call('listing.browser.verify',{accountId,proposalId:prepared.id,observedExternalId:variationId})).result)
      .toMatchObject({status:'UI_READBACK_MATCHED',baselineSnapshotId:grant.plan.baselineSnapshotId,remoteVerified:false});
    expect((await call('operation.measure',{accountId,proposalId:prepared.id,proposalKind:'VARIATION'})).result)
      .toMatchObject({status:'VARIATION_STATE_OBSERVED',variationObservation:{
        externalId:variationId,before:{capturedAt:baselineAt,priceCents:1000,stock:3},after:{capturedAt:observedAt,priceCents:1200,stock:0},
      }});
  });

  it('protege propostas de capa e variação por conta, aprovação e relato humano sem simular execução',async()=>{
    const accountId='acct-ops-5',other='acct-ops-other-5';seedImportAccount(accountId);seedImportAccount(other);
    const listingId='listing-ops-5',at='2025-01-07T23:59:59.999Z';
    db.db.prepare('INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(listingId,accountId,'mercado_livre','MLB-OPS5','Teste','ACTIVE',at,at);
    const insert=db.db.prepare('INSERT INTO listing_snapshots (id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class,evidence_json) VALUES (?,?,?,?,?,?,?,?)');
    insert.run('ops-before',listingId,accountId,at,at,JSON.stringify({orders:10,gmv:100}),'A_PRIMARY_UI',JSON.stringify({filtersAndPeriod:'start_date=2025-01-01|end_date=2025-01-07|status=all'}));
    const media=(await call('media.add',{accountId,filename:'pixel.png',mimeType:'image/png',base64:'iVBORw0KGgo='})).result as any;
    const mediaId=media.id;
    const payload={accountId,listingId,kind:'COVER',mediaId,reason:'Teste de capa'};
    expect((await call('listing.change.prepare',{...payload,accountId:other})).ok).toBe(false);
    const prepared=await call('listing.change.prepare',payload);
    expect(prepared.ok).toBe(true);
    const id=(prepared.result as any).id;
    const receipt={accountId,proposalKind:'LISTING_CHANGE',proposalId:id,performedAt:'2025-01-08T12:00:00.000Z',evidenceReference:'Relatório de alteração',confirmedManualExecution:true};
    expect((await call('operation.receipt.record',receipt)).ok).toBe(false);
    expect((await call('listing.change.review',{accountId:other,id,decision:'APPROVED',reason:'Teste'})).ok).toBe(false);
    expect((await call('listing.change.review',{accountId,id,decision:'APPROVED',reason:'Teste'})).result).toMatchObject({status:'APPROVED',published:false});
    expect((await call('listing.change.review',{accountId,id,decision:'REJECTED',reason:'Teste'})).ok).toBe(false);
    db.db.prepare('UPDATE listing_change_proposals SET updated_at=? WHERE id=?').run('2025-01-08T10:00:00.000Z',id);
    expect((await call('operation.receipt.record',{...receipt,accountId:other})).ok).toBe(false);
    expect((await call('operation.receipt.record',receipt)).result).toMatchObject({status:'HUMAN_REPORTED',remoteVerified:false});
    expect((await call('operation.receipt.record',receipt)).ok).toBe(false);
    expect((await call('operation.receipt.list',{accountId:other})).result).toEqual([]);
    expect((await call('operation.measure',{accountId,proposalKind:'LISTING_CHANGE',proposalId:id})).result).toMatchObject({status:'INSUFFICIENT_COMPATIBLE_WINDOWS',remoteVerified:false});
    const after='2025-01-16T12:00:00.000Z';
    insert.run('ops-after',listingId,accountId,after,after,JSON.stringify({orders:12,gmv:120}),'A_PRIMARY_UI',JSON.stringify({filtersAndPeriod:'start_date=2025-01-09|end_date=2025-01-15|status=all'}));
    expect((await call('operation.measure',{accountId,proposalKind:'LISTING_CHANGE',proposalId:id})).result).toMatchObject({status:'OBSERVED_CHANGE',metrics:{orders:{before:10,after:12,deltaPct:20}},remoteVerified:false,causalityVerified:false});
    const campaign=(await call('campaign.change.prepare',{accountId,marketplace:'mercado_livre',campaignRef:'C-OPS',baseline:{budget:10},changes:{budget:15},reason:'Revisão de teste'})).result as any;
    expect((await call('campaign.change.review',{accountId:other,proposalId:campaign.id,decision:'APPROVED',reason:'Teste'})).ok).toBe(false);
    expect((await call('campaign.change.review',{accountId,proposalId:campaign.id,decision:'APPROVED',reason:'Teste'})).result).toMatchObject({status:'APPROVED',changedRemotely:false});
    expect((await call('campaign.change.review',{accountId,proposalId:campaign.id,decision:'APPROVED',reason:'Teste'})).ok).toBe(false);
    const variant=(await call('offer.variation.prepare',{accountId,listingId,variationName:'Cor',options:[{name:'Azul'}]})).result as any;
    expect((await call('offer.variation.update',{accountId:other,id:variant.id,variationName:'Cor',options:[{name:'Preto'}]})).ok).toBe(false);
    expect((await call('offer.variation.update',{accountId,id:variant.id,variationName:'Cor',options:[{name:'Preto'}]})).result).toMatchObject({status:'DRAFT',published:false});
    expect((await call('offer.variation.delete',{accountId,id:variant.id})).ok).toBe(true);
    expect((await call('offer.variation.list',{accountId})).result).toEqual([]);
    const next=(await call('offer.variation.prepare',{accountId,listingId,variationName:'Tamanho',options:[{name:'M'}]})).result as any;
    expect((await call('offer.variation.review',{accountId:other,id:next.id,decision:'APPROVED',reason:'Teste'})).ok).toBe(false);
    expect((await call('offer.variation.review',{accountId,id:next.id,decision:'APPROVED',reason:'Teste'})).result).toMatchObject({status:'APPROVED',published:false});
    expect((await call('offer.variation.delete',{accountId,id:next.id})).ok).toBe(false);

  });

  it('armazena reclamações e motivos de devolução com deduplicação e redação de PII', async () => {
    seedImportAccount('acct-voc');
    const inserted = await call('voc.ingestBatch', { accountId: 'acct-voc', items: [
      { kind: 'COMPLAINT', text: 'Meu pedido atrasou, contato teste@example.com', externalRef: 'complaint-1' },
      { kind: 'RETURN_REASON', text: 'Produto chegou quebrado', externalRef: 'return-1' },
      { kind: 'COMPLAINT', text: 'Meu pedido atrasou, contato teste@example.com', externalRef: 'complaint-1' },
    ] });
    expect(inserted.ok).toBe(true);
    expect((inserted.result as any).inserted).toBe(2);
    expect((inserted.result as any).duplicates).toBe(1);
    const rows = db.rows<{ kind: string; text_redacted: string }>('SELECT kind,text_redacted FROM customer_voice_items WHERE account_id=? ORDER BY kind', 'acct-voc');
    expect(rows.some((row) => row.kind === 'COMPLAINT' && row.text_redacted.includes('[email]'))).toBe(true);
    expect(rows.some((row) => row.kind === 'RETURN_REASON')).toBe(true);
  });

  it('executa schedules vencidos em ciclos controlados e registra execuções', async () => {
    seedImportAccount('acct-schedule');
    const analysis = await call('analysis.schedule.create', { accountId: 'acct-schedule', mode: 'RAPIDA', days: 7, cadence: 'daily' });
    const report = await call('report.schedule.create', { accountId: 'acct-schedule', reportType: 'EXECUTIVO', format: 'json', cadence: 'daily' });
    expect(analysis.ok && report.ok).toBe(true);
    db.db.prepare("UPDATE analysis_schedules SET next_run_at='2000-01-01T00:00:00.000Z' WHERE id=?").run((analysis.result as any).id);
    db.db.prepare("UPDATE report_schedules SET next_run_at='2000-01-01T00:00:00.000Z' WHERE id=?").run((report.result as any).id);
    const processed = await service.processScheduledWork();
    expect(processed.analyses).toBe(1);
    expect(processed.reports).toBe(1);
    const runs = await call('report.schedule.runs', { scheduleId: (report.result as any).id });
    expect((runs.result as any[])).toHaveLength(1);
    expect((runs.result as any[])[0].status).toBe('COMPLETED');
  });

  it('importa texto de PDF digital apenas para staging e preserva revisão manual', async () => {
    seedImportAccount('acct-pdf');
    const pdf = '%PDF-1.4\n1 0 obj << >> stream\nBT /F1 12 Tf (Relatorio mensal) Tj ET\nendstream\nendobj\n%%EOF';
    const imported = await call('connector.import', { accountId: 'acct-pdf', fileName: 'relatorio.pdf', fileType: 'pdf', base64: Buffer.from(pdf, 'latin1').toString('base64') });
    expect(imported.ok).toBe(true);
    expect((imported.result as any).staged).toBe(true);
    expect((imported.result as any).status).toBe('PENDENTE_VALIDACAO');
    expect((imported.result as any).extractedTextChars).toBeGreaterThan(0);
    const job = db.row<{ status: string }>('SELECT status FROM import_jobs WHERE id=?', (imported.result as any).jobId);
    expect(job?.status).toBe('PENDENTE_VALIDACAO');
  });

  it('registra conectores externos como não conectados enquanto faltarem adapters OAuth/API', async () => {
    const registry = db.rows<{ id: string; status: string }>('SELECT id,status FROM connector_registry WHERE id IN (\'google_analytics4\',\'google_search_console\',\'google_trends_public\') ORDER BY id');
    expect(registry).toHaveLength(3);
    expect(registry.every((row) => row.status === 'NAO_CONECTADO')).toBe(true);
  });
});

describe('restauração segura de backup', () => {
  it('não reativa sessões do backup depois de restaurar', async () => {
    const backup = db.backup('sessão antiga');
    db.db.prepare("UPDATE auth_sessions SET revoked_at=?").run(new Date().toISOString());
    db.restoreBackup(backup.id);
    expect((await call('account.list')).error?.code).toBe('UNAUTHORIZED');
    const login = await call('auth.login', { email: 'admin@local.test', password: 'senha-forte-123' }, false);
    expect((login.result as { ok: boolean }).ok).toBe(true);
  });

  it('recusa restauração com leitor WAL ativo sem apagar o banco original', () => {
    db.db.exec('CREATE TABLE restore_busy_probe (value TEXT NOT NULL)');
    db.db.prepare('INSERT INTO restore_busy_probe VALUES (?)').run('antigo');
    const backup = db.backup('leitor ativo');
    const reader = new LocalDatabase({ file: db.file });
    try {
      reader.db.exec('BEGIN');
      reader.db.prepare('SELECT * FROM restore_busy_probe').all();
      db.db.prepare('UPDATE restore_busy_probe SET value=?').run('atual');
      db.db.exec('PRAGMA busy_timeout=50');
      expect(() => db.restoreBackup(backup.id)).toThrow(/ocupado/);
      expect(db.row<{value:string}>('SELECT value FROM restore_busy_probe')?.value).toBe('atual');
    } finally { reader.db.exec('ROLLBACK'); reader.close(); }
  });

  it('restaura somente backup registrado e validado, preservando o estado anterior', () => {
    db.db.exec('CREATE TABLE restore_probe (value TEXT NOT NULL)');
    db.db.prepare('INSERT INTO restore_probe(value) VALUES (?)').run('estado-original');
    const backup = db.backup('teste de restauração');
    db.db.prepare('UPDATE restore_probe SET value=?').run('estado-posterior');
    const restored = db.restoreBackup(backup.id);
    expect(db.row<{value:string}>('SELECT value FROM restore_probe')?.value).toBe('estado-original');
    expect(restored.integrity.ok).toBe(true);
    expect(restored.previousFile.endsWith('.bak')).toBe(true);
  });

  it('recusa backup adulterado pelo checksum registrado', () => {
    const backup = db.backup('teste checksum');
    writeFileSync(backup.path, 'arquivo alterado');
    expect(() => db.restoreBackup(backup.id)).toThrow(/checksum/);
  });

  it('expõe restauração por IPC apenas com confirmação explícita', async () => {
    db.db.exec('CREATE TABLE restore_ipc_probe (value TEXT NOT NULL)');
    db.db.prepare('INSERT INTO restore_ipc_probe(value) VALUES (?)').run('valor salvo');
    const backup = db.backup('teste IPC restore');
    db.db.prepare('UPDATE restore_ipc_probe SET value=?').run('valor novo');
    const rejected = await call('backup.restore', { backupId: backup.id, confirmed: false });
    expect(rejected.ok).toBe(false);
    const result = await call('backup.restore', { backupId: backup.id, confirmed: true });
    expect(result.ok).toBe(true);
    expect(db.row<{value:string}>('SELECT value FROM restore_ipc_probe')?.value).toBe('valor salvo');
  });
});

describe('evidência em snapshots individuais', () => {
  it('preserva rótulos financeiros e filtros/período em snapshots de anúncio', async () => {
    seedImportAccount('acct-listing-evidence');
    const at = '2026-11-26T15:00:00.000Z';
    const captured = await call('capture.ingest', {
      marketplace: 'mercado_livre', accountId: 'acct-listing-evidence', pageKind: 'product_detail',
      url: 'https://www.mercadolivre.com.br/anuncio/ML-TESTE-001', sourceClass: 'A_PRIMARY_UI',
      referenceAt: at, collectedAt: at, method: 'content_script_dom',
      listings: [{ listingId: 'ML-TESTE-001', title: 'Produto teste', gmv: 1200, netRevenue: 1080, commission: 72 }],
      evidence: { gmv: 'Faturamento bruto', netRevenue: 'Receita líquida', commission: 'Comissão', filtersAndPeriod: '["Período=Últimos 7 dias"]' },
    });
    expect(captured.ok).toBe(true);
    const row = db.row<{ evidence_json: string; metrics_json: string }>(
      'SELECT evidence_json,metrics_json FROM listing_snapshots WHERE account_id=?', 'acct-listing-evidence',
    );
    expect(JSON.parse(row!.evidence_json)).toMatchObject({
      gmv: 'Faturamento bruto', netRevenue: 'Receita líquida', commission: 'Comissão',
      filtersAndPeriod: '["Período=Últimos 7 dias"]',
    });
    expect(JSON.parse(row!.metrics_json)).toMatchObject({ gmv: 1200, netRevenue: 1080, commission: 72 });
  });
});

describe('captura de métricas agregadas da conta', () => {
  it('aceita página de Ads sem listingId e alimenta histórico com proveniência', async () => {
    seedImportAccount('acct-account-snapshot');
    const at = new Date().toISOString();
    const captured = await call('capture.ingest', {
      marketplace: 'mercado_livre', accountId: 'acct-account-snapshot', pageKind: 'seller_ads',
      url: 'https://www.mercadolivre.com.br/anuncios/publicidade', sourceClass: 'A_PRIMARY_UI',
      referenceAt: at, collectedAt: at, method: 'content_script_dom', listings: [],
      accountMetrics: { adSpend: 85.5, adClicks: 120, adAttributedRevenue: 410.25, adAttributedOrders: 7 },
      evidence: { adSpend: 'Investimento em publicidade', adClicks: 'Cliques em anúncios' },
    });
    expect(captured.ok).toBe(true);
    const result = captured.result as { accountSnapshotsIngested: number; listingsIngested: number };
    expect(result.accountSnapshotsIngested).toBe(1);
    expect(result.listingsIngested).toBe(0);
    expect(db.row<{ count:number }>('SELECT COUNT(*) AS count FROM account_snapshots WHERE account_id=?','acct-account-snapshot')?.count).toBe(1);
    expect(db.row<{ count:number }>("SELECT COUNT(*) AS count FROM data_provenance WHERE entity='account_snapshot' AND account_id=?",'acct-account-snapshot')?.count).toBe(4);
    const history = await call('kpi.history', { accountId: 'acct-account-snapshot', days: 30 });
    expect(history.ok).toBe(true);
    const points = (history.result as { points:Array<Record<string,unknown>> }).points;
    expect(points).toHaveLength(1);
    expect(points[0]!.adSpendCents).toBe(8550);
    expect(points[0]!.adAttributedRevenueCents).toBe(41025);
    expect(points[0]!.gmv).toBeNull();
  });

  it('armazena receita líquida e taxas observadas em métricas agregadas com evidência', async () => {
    seedImportAccount('acct-fees');
    const at = new Date().toISOString();
    const captured = await call('capture.ingest', {
      marketplace: 'mercado_livre', accountId: 'acct-fees', pageKind: 'seller_orders',
      url: 'https://www.mercadolivre.com.br/vendas/pedidos', sourceClass: 'A_PRIMARY_UI',
      referenceAt: at, collectedAt: at, method: 'content_script_dom', listings: [],
      accountMetrics: { gmv: 1000, netRevenue: 910, commission: 65, fixedFee: 5, shippingFee: 12, tax: 8, marketplaceFee: 3 },
      evidence: { netRevenue: 'Receita líquida', commission: 'Comissão', fixedFee: 'Tarifa fixa' },
    });
    expect(captured.ok).toBe(true);
    const row = db.row<{ metrics_json:string; evidence_json:string }>('SELECT metrics_json,evidence_json FROM account_snapshots WHERE account_id=?','acct-fees');
    expect(JSON.parse(row!.metrics_json)).toMatchObject({ netRevenue:910,commission:65,fixedFee:5,shippingFee:12,tax:8,marketplaceFee:3 });
    expect(JSON.parse(row!.evidence_json)).toMatchObject({ netRevenue:'Receita líquida',commission:'Comissão' });
    const history = await call('kpi.history', { accountId:'acct-fees',days:30 });
    const point = (history.result as {points:Array<Record<string,unknown>>}).points[0]!;
    expect(point.netRevenueCents).toBe(91000);
    expect(point.commission).toBe(65);
    expect(point.fixedFee).toBe(5);
  });

  it('recusa payload sem anúncios e sem métricas agregadas', async () => {
    seedImportAccount('acct-account-empty');
    const result = await call('capture.ingest', {
      marketplace: 'mercado_livre', accountId: 'acct-account-empty', pageKind: 'seller_ads',
      url: 'https://www.mercadolivre.com.br/anuncios/publicidade', sourceClass: 'A_PRIMARY_UI',
      referenceAt: '2026-11-26T13:00:00.000Z', collectedAt: '2026-11-26T13:00:00.000Z', method: 'content_script_dom', listings: [],
    });
    expect(result.result).toMatchObject({ ok: false, errors: [expect.stringContaining('captura sem anúncios, detalhes nem métricas de conta')] });
  });
});

describe('SKU e captura isolados por conta', () => {
  it('permite o mesmo código SKU em duas lojas e associa cada anúncio ao SKU correto', async () => {
    seedImportAccount('acct-sku-a');
    seedImportAccount('acct-sku-b');
    const capture = (accountId: string, listingId: string, at: string) => service.handle({
      id: `capture-${listingId}`, protocolVersion: 1, method: 'capture.ingest', token,
      payload: {
        marketplace: 'mercado_livre', accountId, pageKind: 'seller_listings',
        url: 'https://www.mercadolivre.com.br/anuncios', sourceClass: 'A_PRIMARY_UI',
        referenceAt: at, collectedAt: at, method: 'content_script_dom',
        listings: [{ listingId, sku: 'SKU-REPETIDO', title: `Produto ${listingId}`, stockAvailable: 4 }],
        evidence: { source: 'regression-test' },
      },
    });
    const atA = '2026-11-26T12:00:00.000Z';
    const atB = '2026-11-26T12:01:00.000Z';
    const resultA = await capture('acct-sku-a', 'ML-SKU-A', atA);
    const resultB = await capture('acct-sku-b', 'ML-SKU-B', atB);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    const rows = db.rows<{account_id:string;sku_id:string}>('SELECT account_id,sku_id FROM listings WHERE external_id IN (?,?) ORDER BY account_id','ML-SKU-A','ML-SKU-B');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.account_id).not.toBe(rows[1]!.account_id);
    expect(rows[0]!.sku_id).not.toBe(rows[1]!.sku_id);
    expect(db.row<{count:number}>('SELECT COUNT(*) AS count FROM skus WHERE sku_code=?','SKU-REPETIDO')?.count).toBe(2);
    expect(db.db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});

describe('adapter Amazon Seller Central', () => {
  it('reconhece somente o domínio Seller Central e declara captura parcial', () => {
    expect(adapterForUrl('https://sellercentral.amazon.com.br/myinventory/inventory')).toBe(amazonAdapter);
    expect(adapterForUrl('https://sellercentral.amazon.com/')).toBeNull();
    expect(amazonAdapter.capabilities.listing_capture).toBe('PARCIALMENTE_SUPORTADO');
    expect(amazonAdapter.capabilities.ads_capture).toBe('NAO_DISPONIVEL');
    expect(amazonAdapter.detectPage('https://sellercentral.amazon.com.br/myinventory/inventory', [])?.kind).toBe('seller_listings');
  });
});

describe('importação de arquivos em staging', () => {
  it('interpreta CSV e mantém as linhas pendentes de mapeamento, sem promover KPIs', async () => {
    seedImportAccount('acct-stage-csv');
    const response = await call('connector.import', {
      fileName: 'vendas.csv', fileType: 'csv', accountId: 'acct-stage-csv', csvText: 'pedido;valor\nP-1;19.90\nP-2;25.00',
    });
    expect(response.ok).toBe(true);
    const result = response.result as { jobId: string; rowCount: number; status: string; staged: boolean };
    expect(result.rowCount).toBe(2);
    expect(result.status).toBe('PENDENTE_VALIDACAO');
    expect(result.staged).toBe(true);
    expect(db.row<{ count: number }>('SELECT COUNT(*) AS count FROM import_job_rows WHERE job_id=?', result.jobId)?.count).toBe(2);
    expect(db.row<{ status: string }>('SELECT status FROM import_jobs WHERE id=?', result.jobId)?.status).toBe('PENDENTE_VALIDACAO');
  });

  it('interpreta XLSX real e cria staging sem aplicar linhas ao catálogo', async () => {
    seedImportAccount('acct-stage-xlsx');
    const xlsx = readFileSync(new URL('./fixtures/tabular-mini.xlsx', import.meta.url)).toString('base64');
    const response = await call('connector.import', {
      fileName: 'relatorio.xlsx', fileType: 'xlsx', accountId: 'acct-stage-xlsx', base64: xlsx,
    });
    expect(response.ok).toBe(true);
    const result = response.result as { jobId: string; rowCount: number; previewRows: Array<Record<string, unknown>> };
    expect(result.rowCount).toBe(2);
    expect(result.previewRows[0]).toEqual({ Indicador: 'revenue', Valor: 1234.5 });
    expect(db.row<{ count: number }>('SELECT COUNT(*) AS count FROM import_job_rows WHERE job_id=?', result.jobId)?.count).toBe(2);
    expect(db.row<{ count: number }>('SELECT COUNT(*) AS count FROM catalog_products')?.count).toBe(0);
  });

  it('promove CSV mapeado para snapshots por conta e registra proveniência', async () => {
    const at = '2026-11-25T14:00:00.000Z';
    db.db.prepare('INSERT INTO accounts (id,marketplace,external_ref,display_name,handle,detection_confidence,verified_by_user,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('acct-import','mercado_livre','seller-import','Loja Importação','loja-import',1,1,1,at,at);
    db.db.prepare('INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('listing-import','acct-import','mercado_livre','ML-123','Produto teste','ACTIVE',at,at);
    const staged = await call('connector.import', {
      fileName: 'indicadores.csv', fileType: 'csv', accountId: 'acct-import',
      csvText: 'anuncio;faturamento;pedidos;data\nML-123;1.234,50;4;2026-11-25T14:00:00.000Z',
    });
    expect(staged.ok).toBe(true);
    const jobId = (staged.result as { jobId: string }).jobId;
    const committed = await call('connector.import.commit', {
      jobId, accountId: 'acct-import',
      mapping: { externalId: 'anuncio', capturedAt: 'data', metrics: { gmv: 'faturamento', orders: 'pedidos' } },
    });
    expect(committed.ok).toBe(true);
    const snapshot = db.row<{ metrics_json: string; source_class: string }>('SELECT metrics_json,source_class FROM listing_snapshots WHERE listing_id=?', 'listing-import');
    expect(snapshot?.source_class).toBe('F_USER_INPUT');
    expect(JSON.parse(snapshot!.metrics_json)).toEqual({ gmv: 1234.5, orders: 4 });
    expect(db.row<{ count: number }>("SELECT COUNT(*) AS count FROM data_provenance WHERE entity='listing_snapshot' AND entity_id=(SELECT id FROM listing_snapshots WHERE listing_id='listing-import')")?.count).toBe(2);
    expect(db.row<{ status: string }>('SELECT status FROM import_jobs WHERE id=?', jobId)?.status).toBe('IMPORTADO_VALIDADO');
  });
});

describe('comparação de períodos e entidades', () => {
  it('compara snapshots de dois períodos por anúncio sem somar capturas repetidas', async () => {
    const at='2026-11-01T00:00:00.000Z';
    seedImportAccount('acct-compare');
    db.db.prepare('INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('listing-compare','acct-compare','mercado_livre','ML-COMPARE','Anúncio comparável','ACTIVE',at,at);
    db.db.prepare('INSERT INTO listing_snapshots (id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class,quality_score) VALUES (?,?,?,?,?,?,?,?)')
      .run('snap-current','listing-compare','acct-compare','2026-11-20T12:00:00.000Z','2026-11-20T12:00:00.000Z',JSON.stringify({gmv:100,orders:2,visits:50,adSpend:10,adAttributedRevenue:30}),'F_USER_INPUT',0.8);
    db.db.prepare('INSERT INTO listing_snapshots (id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class,quality_score) VALUES (?,?,?,?,?,?,?,?)')
      .run('snap-previous','listing-compare','acct-compare','2026-10-20T12:00:00.000Z','2026-10-20T12:00:00.000Z',JSON.stringify({gmv:80,orders:1,visits:40,adSpend:10,adAttributedRevenue:20}),'F_USER_INPUT',0.8);
    const response=await call('kpi.compare.detail',{accountId:'acct-compare',groupBy:'listing',primaryFrom:'2026-11-01',primaryTo:'2026-11-30',comparisonFrom:'2026-10-01',comparisonTo:'2026-10-31'});
    expect(response.ok).toBe(true);
    const result=response.result as {rows:Array<{current:{metrics:Record<string,number|null>};previous:{metrics:Record<string,number|null>};deltaPct:Record<string,number|null>}>};
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.current.metrics.gmv).toBe(100);
    expect(result.rows[0]!.previous.metrics.gmv).toBe(80);
    expect(result.rows[0]!.deltaPct.gmv).toBe(25);
    expect(result.rows[0]!.current.metrics.roas).toBe(3);
  });

  it('only verifies equivalent closed source windows with the same listing and filters', async () => {
    seedImportAccount('acct-compare-verified');
    const accountId='acct-compare-verified',listingId='listing-compare-verified';
    const at='2025-01-01T00:00:00.000Z';
    db.db.prepare('INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(listingId,accountId,'mercado_livre','ML-VERIFIED','Comparável','ACTIVE',at,at);
    const insert=db.db.prepare('INSERT INTO listing_snapshots (id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class,evidence_json) VALUES (?,?,?,?,?,?,?,?)');
    const evidence=(from:string,to:string,status:string)=>JSON.stringify({filtersAndPeriod:'start_date='+from+'|end_date='+to+'|status='+status});
    insert.run('verified-a',listingId,accountId,'2025-01-14T23:00:00.000Z','2025-01-14T23:00:00.000Z',JSON.stringify({gmv:120,orders:3}),'A_PRIMARY_UI',evidence('2025-01-08','2025-01-14','all'));
    insert.run('verified-b',listingId,accountId,'2025-01-07T23:00:00.000Z','2025-01-07T23:00:00.000Z',JSON.stringify({gmv:100,orders:2}),'A_PRIMARY_UI',evidence('2025-01-01','2025-01-07','all'));
    const payload={accountId,listingId,primaryFrom:'2025-01-08',primaryTo:'2025-01-14',comparisonFrom:'2025-01-01',comparisonTo:'2025-01-07'};
    const verified=await call('kpi.compare.detail',payload);
    expect(verified.ok).toBe(true);
    expect(verified.result).toMatchObject({rows:[{deltaPct:{gmv:20},verifiedDeltaPct:{gmv:20},comparisonQuality:{comparable:true}}]});
    db.db.prepare('UPDATE listing_snapshots SET metrics_json=? WHERE id=?').run(JSON.stringify({gmv:80,orders:10,visits:200,adSpend:120,commission:20,stockAvailable:4}),'verified-a');
    db.db.prepare('UPDATE listing_snapshots SET metrics_json=? WHERE id=?').run(JSON.stringify({gmv:100,orders:20,visits:200,adSpend:100,commission:10,stockAvailable:4}),'verified-b');
    const diagnostics=(await call('kpi.compare.detail',payload)).result as any;
    expect(diagnostics.rows[0].diagnostics.map((d:any)=>d.code)).toEqual(expect.arrayContaining(['SALES_DECLINE','ORDERS_DECLINE','COST_INCREASE','CVR_DECLINE']));
    db.db.prepare('UPDATE listing_snapshots SET metrics_json=? WHERE id=?').run(JSON.stringify({gmv:120,orders:25,visits:200,stockAvailable:4}),'verified-a');
    const growth=(await call('kpi.compare.detail',payload)).result as any;
    expect(growth.rows[0].diagnostics.map((d:any)=>d.code)).toContain('GROWTH_REVIEW');

    db.db.prepare('UPDATE listing_snapshots SET metrics_json=? WHERE id=?').run(JSON.stringify({gmv:6000,orders:60,visits:600,units:72,stockAvailable:120}),'verified-a');
    db.db.prepare('UPDATE listing_snapshots SET metrics_json=? WHERE id=?').run(JSON.stringify({gmv:10000,orders:100,visits:1000,units:120,stockAvailable:300}),'verified-b');
    expect((await call('kpi.compare.detail',payload)).result).toMatchObject({rows:[{revenueDrivers:{deltaCents:-400000,drivers:{trafficCents:-400000,conversionCents:0,ticketCents:0}},growthOpportunity:{underused:true,best:{kind:'TRAFFIC',incrementalGmvCents:100000},funnel:{visits:600,orders:60,conversionPct:10,impressions:null}}}]});
    db.db.prepare('UPDATE listing_snapshots SET metrics_json=?,evidence_json=? WHERE id=?').run(JSON.stringify({gmv:6000,netRevenue:4800,orders:60,visits:600,units:72,stockAvailable:120,organicImpressions:2000,paidImpressions:1000,addToCart:90}),JSON.stringify({filtersAndPeriod:'start_date=2025-01-08|end_date=2025-01-14|status=all',organicImpressions:'Impressões orgânicas',addToCart:'Adições ao carrinho'}),'verified-a');
    expect((await call('finance.realized.upsert',{accountId,listingId,periodStart:'2025-01-08T00:00:00.000Z',periodEnd:'2025-01-14T23:59:59.999Z',netRevenueCents:480000,productCostCents:240000,packagingCents:6000,shippingCents:12000,marketplaceFeesCents:6000,taxesCents:6000,adSpendCents:30000,refundsCents:0,returnLogisticsCents:0,cancellationLossCents:0,otherCostsCents:0,sourceClass:'F_USER_INPUT',evidence:{reference:'fixture'}})).ok).toBe(true);
    expect((await call('kpi.compare.detail',payload)).result).toMatchObject({rows:[{financialGrowth:{status:'HISTORICAL_SCENARIO',profitCents:180000,projectedProfitBeforeExtraActionCostCents:30000},funnelDetails:{organicImpressions:2000,paidImpressions:null,addToCart:90,checkout:null}}]});
    const extraMetrics={gmv:6000,netRevenue:4800,orders:60,visits:600,units:72,stockAvailable:120,totalImpressions:3000,checkoutStarts:80};
    const extraEvidence={filtersAndPeriod:'start_date=2025-01-08|end_date=2025-01-14|status=all',totalImpressions:'page-level only',checkoutStarts:'page-level only'};
    db.db.prepare('UPDATE listing_snapshots SET metrics_json=?,evidence_json=? WHERE id=?').run(JSON.stringify(extraMetrics),JSON.stringify(extraEvidence),'verified-a');
    expect((await call('kpi.compare.detail',payload)).result).toMatchObject({rows:[{funnelDetails:{totalImpressions:null,checkout:null}}]});
    db.db.prepare('UPDATE listing_snapshots SET evidence_json=? WHERE id=?').run(JSON.stringify({...extraEvidence,listingFunnelEvidence:{totalImpressions:'Total de impressões: 3000',checkoutStarts:'Checkouts iniciados: 80'}}),'verified-a');
    expect((await call('kpi.compare.detail',payload)).result).toMatchObject({rows:[{funnelDetails:{totalImpressions:3000,checkout:80}}]});
    db.db.prepare('DELETE FROM realized_profit_snapshots WHERE account_id=? AND listing_id=?').run(accountId,listingId);
    db.db.prepare('UPDATE listing_snapshots SET evidence_json=? WHERE id=?').run(evidence('2025-01-08','2025-01-14','all'),'verified-a');
    db.db.prepare('UPDATE listing_snapshots SET metrics_json=? WHERE id=?').run(JSON.stringify({gmv:120,orders:25,visits:200,stockAvailable:4}),'verified-a');
    db.db.prepare('UPDATE listing_snapshots SET metrics_json=? WHERE id=?').run(JSON.stringify({gmv:100,orders:20,visits:200,adSpend:100,commission:10,stockAvailable:4}),'verified-b');

    db.db.prepare('UPDATE listing_snapshots SET evidence_json=? WHERE id=?').run(evidence('2025-01-01','2025-01-07','active'),'verified-b');
    const incompatible=await call('kpi.compare.detail',payload);
    expect((incompatible.result as any).rows[0].diagnostics).toEqual([]);
    expect(incompatible.result).toMatchObject({rows:[{revenueDrivers:{status:'INSUFFICIENT_EVIDENCE'},growthOpportunity:{status:'INSUFFICIENT_EVIDENCE',best:null}}]});
    expect(incompatible.result).toMatchObject({rows:[{deltaPct:{gmv:20},verifiedDeltaPct:{gmv:null},comparisonQuality:{sameFilters:false,comparable:false}}]});
    const unequal=await call('kpi.compare.detail',{...payload,primaryFrom:'2025-01-09'});
    expect(unequal.result).toMatchObject({rows:[{verifiedDeltaPct:{gmv:null},comparisonQuality:{equalDuration:false,comparable:false}}]});
    expect((await call('kpi.compare.detail',{...payload,listingId:'nonexistent'})).result).toMatchObject({rows:[]});
    insert.run('after-window-a',listingId,accountId,'2025-01-20T12:00:00.000Z','2025-01-20T12:00:00.000Z',JSON.stringify({gmv:6000,orders:60,visits:600,units:72,stockAvailable:120}),'A_PRIMARY_UI',evidence('2025-01-08','2025-01-14','all'));
    insert.run('after-window-b',listingId,accountId,'2025-01-20T13:00:00.000Z','2025-01-20T13:00:00.000Z',JSON.stringify({gmv:10000,orders:100,visits:1000,units:120,stockAvailable:300}),'A_PRIMARY_UI',evidence('2025-01-01','2025-01-07','all'));
    expect((await call('kpi.compare.detail',{...payload,sourceWindows:true})).result).toMatchObject({sourceWindows:true,rows:[{comparisonQuality:{comparable:true},growthOpportunity:{best:{incrementalGmvCents:100000}}}]});
    expect((await call('kpi.compare.detail',{...payload,accountId:undefined,sourceWindows:true})).ok).toBe(false);
    const campaignAt='2025-01-14T22:00:00.000Z';
    const base={marketplace:'mercado_livre',accountId,pageKind:'seller_ads',url:'https://vendedores.mercadolivre.com.br/publicidade',sourceClass:'A_PRIMARY_UI',referenceAt:campaignAt,collectedAt:campaignAt,method:'content_script_dom',listings:[],evidence:{filtersAndPeriod:'start_date=2025-01-08|end_date=2025-01-14|status=all'}};
    const detail=(externalId:string,adSpend:number,adAttributedRevenue:number)=>({kind:'AD_CAMPAIGN',externalId,metrics:{adSpend,adAttributedRevenue},evidence:{adSpend:'Investimento',adAttributedRevenue:'Receita atribuída'}});
    expect((await call('capture.ingest',{...base,details:[detail('C-loss',100,30),detail('C-positive',10,40)]})).ok).toBe(true);
    const campaignResult=(await call('kpi.compare.detail',{...payload,listingId:undefined})).result as any;
    expect(campaignResult.campaigns).toEqual([expect.objectContaining({campaignId:'C-loss',spend:100,attributedRevenue:30})]);
    expect((await call('kpi.compare.detail',payload)).result).toMatchObject({campaigns:[]});
    expect((await call('kpi.compare.detail',{...payload,listingId:undefined,groupBy:'marketplace'})).result).toMatchObject({rows:[{id:'mercado_livre',marketplace:'mercado_livre',comparisonQuality:{coverageVerified:false}}]});
    expect((await call('kpi.compare.detail',{...payload,listingId:undefined,primaryFrom:'2025-01-09'})).result).toMatchObject({campaigns:[]});
  });
});

describe('banco local', () => {
  it('aplica migrações e registra versão', () => {
    const rows = db.rows<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(rows.length).toBeGreaterThan(0);
    expect(db.integrityCheck().ok).toBe(true);
  });

  it('não aplica migração duas vezes', () => {
    const before = db.rows<{ version: number }>('SELECT version FROM schema_migrations').length;
    db.migrate();
    expect(db.rows<{ version: number }>('SELECT version FROM schema_migrations').length).toBe(before);
  });

  it('detecta alteração de migration já aplicada', () => {
    const migrationsDir = join(dir, 'migration-check');
    mkdirSync(migrationsDir, { recursive: true });
    const migrationFile = join(migrationsDir, '0001_probe.sql');
    writeFileSync(migrationFile, 'CREATE TABLE migration_probe (id TEXT PRIMARY KEY);', 'utf8');
    const probeDb = new LocalDatabase({ file: join(dir, 'migration-check.sqlite'), migrationsDir });
    try {
      expect(probeDb.migrate().applied).toEqual([1]);
      writeFileSync(join(migrationsDir, '0002_pending.sql'), 'CREATE TABLE pending_migration_probe (id TEXT PRIMARY KEY);', 'utf8');
      writeFileSync(migrationFile, 'CREATE TABLE migration_probe (id TEXT PRIMARY KEY, note TEXT);', 'utf8');
      expect(() => probeDb.migrate()).toThrow(/foi alterada depois de aplicada/);
      expect(probeDb.row<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_migration_probe'")).toBeNull();
    } finally {
      probeDb.close();
    }
  });

  it('detecta migration aplicada removida do pacote', () => {
    const migrationsDir = join(dir, 'missing-migration-check');
    mkdirSync(migrationsDir, { recursive: true });
    const migrationFile = join(migrationsDir, '0001_probe.sql');
    writeFileSync(migrationFile, 'CREATE TABLE missing_migration_probe (id TEXT PRIMARY KEY);', 'utf8');
    const probeDb = new LocalDatabase({ file: join(dir, 'missing-migration-check.sqlite'), migrationsDir });
    try {
      expect(probeDb.migrate().applied).toEqual([1]);
      rmSync(migrationFile);
      expect(() => probeDb.migrate()).toThrow(/já aplicada não existe no diretório/);
    } finally {
      probeDb.close();
    }
  });

  it('libera savepoints aninhados depois de rollback', () => {
    db.db.exec('CREATE TABLE nested_tx_probe (value TEXT PRIMARY KEY)');
    db.transaction(() => {
      expect(() => db.transaction(() => {
        db.db.prepare('INSERT INTO nested_tx_probe (value) VALUES (?)').run('rollback');
        throw new Error('rollback de teste');
      })).toThrow(/rollback de teste/);
      db.transaction(() => {
        db.db.prepare('INSERT INTO nested_tx_probe (value) VALUES (?)').run('commit');
      });
    });
    expect(db.rows<{ value: string }>('SELECT value FROM nested_tx_probe')).toEqual([{ value: 'commit' }]);
  });

  it('recupera a profundidade transacional após falha de COMMIT', () => {
    db.db.exec('CREATE TABLE tx_parent (id TEXT PRIMARY KEY); CREATE TABLE tx_child (id TEXT REFERENCES tx_parent(id) DEFERRABLE INITIALLY DEFERRED)');
    expect(()=>db.transaction(()=>{db.db.prepare('INSERT INTO tx_child VALUES (?)').run('missing')})).toThrow();
    db.transaction(()=>{db.db.prepare('INSERT INTO tx_parent VALUES (?)').run('valid')});
    expect(db.row('SELECT id FROM tx_parent')).toMatchObject({id:'valid'});
    expect(db.rows('SELECT id FROM tx_child')).toHaveLength(0);
  });

  it('gera backup verificável', () => {
    const b = db.backup('teste');
    expect(b.bytes).toBeGreaterThan(0);
    expect(b.checksum).toHaveLength(64);
    const rows = db.rows<{ path: string }>('SELECT path FROM backups');
    expect(rows.length).toBe(1);
  });
});

describe('autenticação e perfis', () => {
  it('rejeita bootstrap duplicado', async () => {
    const r = await service.handle({ id: 'x', protocolVersion: 1, method: 'auth.bootstrap', payload: { email: 'outro@local.test', password: 'senha-forte-123', displayName: 'Outro' } });
    expect(r.ok).toBe(true);
    expect((r.result as { ok: boolean }).ok).toBe(false);
  });

  it('rejeita senha errada', async () => {
    const r = await call('auth.login', { email: 'admin@local.test', password: 'errada' }, false);
    expect((r.result as { ok: boolean }).ok).toBe(false);
  });

  it('bloqueia método protegido sem token', async () => {
    const r = await call('task.list', {}, false);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('UNAUTHORIZED');
  });

  it('rejeita versão de protocolo incompatível antes de executar o método', async () => {
    const r = await service.handle({ id: 'future', protocolVersion: 2, method: 'ping', payload: {} });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('PROTOCOL_MISMATCH');
  });

  it('bloqueia método inexistente', async () => {
    const r = await call('metodo.fantasma', {});
    expect(r.ok).toBe(false);
    expect(['NOT_FOUND', 'VALIDATION_ERROR']).toContain(r.error?.code);
  });

  it('visualizador não pode executar tarefa nem chamar métodos de escrita sem permissão', async () => {
    const { hash, salt } = hashPassword('senha-visualizador-123');
    db.db
      .prepare('INSERT INTO users (id, email, display_name, role, password_hash, password_salt, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
      .run('u2', 'view@local.test', 'View', 'visualizador', hash, salt, new Date().toISOString());
    const login = await service.handle({ id: 'l', protocolVersion: 1, method: 'auth.login', payload: { email: 'view@local.test', password: 'senha-visualizador-123' } });
    expect(login.ok).toBe(true);
    const viewerToken = (login.result as { token: string }).token;
    const viewerCall = (method: string, payload: unknown = {}) =>
      service.handle({ id: 'viewer', protocolVersion: 1, method, payload, token: viewerToken });

    const task = await viewerCall('task.runNow', { taskId: 'missing' });
    expect(task.ok).toBe(false);
    expect(task.error?.code).toBe('FORBIDDEN');

    const cost = await viewerCall('finance.costs.upsert', { skuId: 'SKU1', unitCostCents: 1000 });
    expect(cost.ok).toBe(false);
    expect(cost.error?.code).toBe('FORBIDDEN');

    const competitor = await viewerCall('competitor.approve', { relationId: 'missing' });
    expect(competitor.ok).toBe(false);
    expect(competitor.error?.code).toBe('FORBIDDEN');

    const read = await viewerCall('competitor.list', { accountId: 'acc-test' });
    expect(read.ok).toBe(true);
  });

  it('não permite que uma sessão encerre a sessão de outro usuário', async () => {
    const { hash, salt } = hashPassword('senha-visualizador-456');
    db.db
      .prepare('INSERT INTO users (id, email, display_name, role, password_hash, password_salt, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
      .run('u3', 'other@local.test', 'Other', 'visualizador', hash, salt, new Date().toISOString());
    const login = await service.handle({ id: 'other-login', protocolVersion: 1, method: 'auth.login', payload: { email: 'other@local.test', password: 'senha-visualizador-456' } });
    const otherToken = (login.result as { token: string }).token;
    const attempt = await call('auth.logout', { token: otherToken });
    expect(attempt.ok).toBe(true);
    expect((attempt.result as { ok: boolean }).ok).toBe(false);
    const stillValid = await service.handle({ id: 'other-session', protocolVersion: 1, method: 'auth.session', payload: { token: otherToken } });
    expect((stillValid.result as { ok: boolean }).ok).toBe(true);
  });

  it('nega sessão de usuário inativo mesmo quando revogação não foi executada', async () => {
    db.db.prepare("UPDATE users SET is_active=0 WHERE email='admin@local.test'").run();
    expect((await call('account.list')).error?.code).toBe('UNAUTHORIZED');
  });
  it('nega sessão com data de expiração inválida', async () => {
    db.db.prepare("UPDATE auth_sessions SET expires_at='invalido'").run();
    expect((await call('account.list')).error?.code).toBe('UNAUTHORIZED');
  });
  it('revoga todas as sessões ao trocar senha', async () => {
    const admin = db.row<{ id: string }>("SELECT id FROM users WHERE email='admin@local.test'")!;
    const changed = await call('user.upsert', { id: admin.id, email: 'admin@local.test', displayName: 'Admin', role: 'super_admin', password: 'nova-senha-forte-123' });
    expect(changed.ok).toBe(true);
    expect((await call('account.list')).error?.code).toBe('UNAUTHORIZED');
    const login = await call('auth.login', { email: 'admin@local.test', password: 'nova-senha-forte-123' }, false);
    expect((login.result as { ok: boolean }).ok).toBe(true);
  });
  it('não sobrescreve cadastro de conta pertencente a outro marketplace', async () => {
    seedImportAccount('acct-scope');
    const result = await call('account.upsert', { marketplace: 'shopee', accountId: 'acct-scope', displayName: 'Outro', confidence: 1, verifiedByUser: true });
    expect(result.ok).toBe(false);
    expect(db.row('SELECT marketplace,display_name FROM accounts WHERE id=?', 'acct-scope')).toMatchObject({ marketplace: 'mercado_livre', display_name: 'Loja acct-scope' });
  });

  it('registra auditoria de login', async () => {
    const rows = db.rows<{ action: string; result: string }>('SELECT action, result FROM audit_log');
    expect(rows.some((r) => r.action === 'LOGIN' && r.result === 'OK')).toBe(true);
    expect(rows.some((r) => r.action === 'BOOTSTRAP')).toBe(true);
  });
});

describe('workspace 3.3.0', () => {
  it('ativa e desativa contas sem apagá-las', async () => {
    const created = await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:workspace', displayName: 'Workspace', confidence: 1, verifiedByUser: true });
    expect(created.ok).toBe(true);
    const disabled = await call('account.setActive', { accountId: 'ml:workspace', isActive: false });
    expect(disabled.ok).toBe(true);
    const rows = (await call('account.list')).result as Array<{ id: string; is_active: number }>;
    expect(rows.find((x) => x.id === 'ml:workspace')?.is_active).toBe(0);
    const enabled = await call('account.setActive', { accountId: 'ml:workspace', isActive: true });
    expect(enabled.ok).toBe(true);
  });

  it('administra usuários sem expor hashes e protege o último super_admin', async () => {
    const created = await call('user.upsert', { email: 'operator@local.test', displayName: 'Operador', role: 'operador', password: 'senha-operador-123' });
    expect(created.ok).toBe(true);
    const users = (await call('user.list')).result as Array<Record<string, unknown>>;
    expect(users.some((u) => u.email === 'operator@local.test')).toBe(true);
    expect(users.every((u) => !('password_hash' in u) && !('password_salt' in u))).toBe(true);
    const id = String((created.result as { id: string }).id);
    expect((await call('user.setActive', { userId: id, isActive: false })).ok).toBe(true);
    const lastAdmin = await call('user.setActive', { userId: String(db.rows<{ id: string }>("SELECT id FROM users WHERE role='super_admin'")[0]!.id), isActive: false });
    expect(lastAdmin.ok).toBe(false);
  });

  it('cadastra catálogo, SKU e custos vinculados', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:catalog', displayName: 'Catálogo', confidence: 1, verifiedByUser: true });
    const product = await call('catalog.product.upsert', { accountId: 'ml:catalog', name: 'Produto teste', brand: 'Marca', model: 'M1', category: 'Acessórios' });
    expect(product.ok).toBe(true);
    const productId = String((product.result as { id: string }).id);
    const sku = await call('catalog.sku.upsert', { accountId: 'ml:catalog', productId, sku: 'SKU-TEST-33', ean: '7890000000000', attributes: { color: 'preto' } });
    expect(sku.ok).toBe(true);
    expect((await call('catalog.sku.list', { accountId: 'ml:catalog' })).result).toHaveLength(1);
    await call('account.upsert', { marketplace: 'shopee', accountId: 'sh:other', displayName: 'Outra', confidence: 1, verifiedByUser: true });
    const crossAccount = await call('catalog.sku.upsert', { accountId: 'sh:other', productId, sku: 'SKU-CROSS-33' });
    expect(crossAccount.ok).toBe(false);
    const cost = await call('finance.costs.upsert', { accountId: 'ml:catalog', sku: 'SKU-TEST-33', costCents: 1250 });
    expect(cost.ok).toBe(true);
    expect(db.row<{ unit_cost_cents: number }>('SELECT unit_cost_cents FROM sku_costs WHERE sku_id = ?', String((sku.result as { id: string }).id))?.unit_cost_cents).toBe(1250);
  });

  it('armazena mídia local com assinatura e checksum', async () => {
    seedImportAccount('ml:catalog');
    const result = await call('media.add', { accountId: 'ml:catalog', filename: 'pixel.png', mimeType: 'image/png', base64: 'iVBORw0KGgo=', altText: 'Teste' });
    expect(result.ok).toBe(true);
    const id = String((result.result as { id: string }).id);
    const item = await call('media.get', { id, accountId: 'ml:catalog' });
    expect(item.ok).toBe(true);
    expect((item.result as { sha256: string }).sha256).toHaveLength(64);
    expect((await call('media.get', { id, accountId: 'other-account' })).ok).toBe(false);
    expect((await call('media.delete', { id, accountId: 'other-account' })).ok).toBe(false);
    expect((await call('media.delete', { id, accountId: 'ml:catalog' })).ok).toBe(true);
  });

  it('cria iniciativas Growth, calcula prioridade e altera status', async () => {
    const result = await call('growth.initiative.upsert', { title: 'Aumentar conversão', hypothesis: 'Fotos novas aumentam confiança', pillar: 'conversion_cro', reach: 100, impact: 4, confidence: 0.8, effort: 2, urgency: 1 });
    expect(result.ok).toBe(true);
    const id = String((result.result as { id: string }).id);
    const listed = await call('growth.initiatives');
    const row = (listed.result as Array<Record<string, unknown>>).find((x) => x.id === id);
    expect(Number(row?.priority_score)).toBeGreaterThan(0);
    expect((await call('growth.initiative.setStatus', { id, status: 'IN_PROGRESS' })).ok).toBe(true);
  });

  it('retorna comparação e modo de análise mesmo sem anúncios capturados', async () => {
    const compare = await call('kpi.compare', {});
    expect(compare.ok).toBe(true);
    const analysis = await call('analysis.run', { mode: 'RAPIDA', days: 30 });
    expect(analysis.ok).toBe(true);
    expect((analysis.result as { listingCount: number }).listingCount).toBe(0);
  });
});

describe('análise por produto de catálogo', () => {
  it('inclui apenas anúncios vinculados ao produto canônico dentro da conta', async () => {
    seedImportAccount('acct-product-analysis');
    seedImportAccount('acct-product-other');
    const product = await call('catalog.product.upsert', { accountId:'acct-product-analysis',name:'Capacete Modelo X' });
    const productId = (product.result as {id:string}).id;
    await call('catalog.sku.upsert', { accountId:'acct-product-analysis',productId,sku:'CAP-X-01' });
    const at = '2026-11-26T14:30:00.000Z';
    const captureListing = (accountId:string, externalId:string, sku:string) => call('capture.ingest', {
      marketplace:'mercado_livre',accountId,pageKind:'seller_listings',url:'https://www.mercadolivre.com.br/anuncios',
      sourceClass:'A_PRIMARY_UI',referenceAt:at,collectedAt:at,method:'content_script_dom',
      listings:[{listingId:externalId,sku,title:externalId,gmv:500,orders:5,visits:100}],
    });
    expect((await captureListing('acct-product-analysis','ML-PROD-1','CAP-X-01')).ok).toBe(true);
    expect((await captureListing('acct-product-other','ML-PROD-2','CAP-X-01')).ok).toBe(true);
    const result = await call('analysis.run', { mode:'RAPIDA',accountId:'acct-product-analysis',catalogProductId:productId,days:30 });
    expect(result.ok).toBe(true);
    expect((result.result as {scope:string;listingCount:number}).scope).toBe('catalog_product');
    expect((result.result as {listingCount:number;totalMatched:number;truncated:boolean}).listingCount).toBe(1);
    expect((result.result as {totalMatched:number}).totalMatched).toBe(1);
    expect((result.result as {truncated:boolean}).truncated).toBe(false);
    const single=await call('analysis.run',{mode:'360',accountId:'acct-product-analysis',listingId:'ML-PROD-1',agents:['finance'],days:30});
    expect(single.result).toMatchObject({listingCount:1,agents:['finance'],analyses:[{contextEvidence:{windowVerified:false,marginPct:null},director:{finalAction:null}}]});
  });
});

describe('captura e KPIs', () => {
  const payload = {
    marketplace: 'mercado_livre',
    accountId: 'ml:conta1',
    pageKind: 'seller_dashboard',
    url: 'https://www.mercadolivre.com.br/vendas',
    collectedAt: new Date().toISOString(),
    referenceAt: new Date().toISOString(),
    sourceClass: 'A_PRIMARY_UI',
    method: 'dom_read',
    listings: [
      {
        listingId: 'MLB123',
        title: 'Fone Bluetooth',
        visits: 1000,
        orders: 30,
        units: 32,
        gmv: 3200,
        organicImpressions: 8000,
        paidImpressions: 2000,
        adSpend: 200,
        adClicks: 400,
        adAttributedRevenue: 900,
        returnsCount: 1,
        returnsValue: 100,
        stockAvailable: 40,
        reviewRating: 4.5,
        reviewCount: 20,
      },
    ],
  };

  it('rejeita captura de conta inexistente', async () => {
    const r = await call('capture.ingest', payload);
    const res = r.result as { ok: boolean; errors: string[] };
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toContain('não cadastrada');
  });

  it('rejeita captura quando a conta pertence a outro marketplace', async () => {
    await call('account.upsert', {
      marketplace: 'shopee',
      accountId: 'sh:conta1',
      displayName: 'Loja Shopee',
      confidence: 1,
      verifiedByUser: true,
    });
    const r = await call('capture.ingest', { ...payload, accountId: 'sh:conta1' });
    const result = r.result as { ok: boolean; listingsIngested: number; errors: string[] };
    expect(result.ok).toBe(false);
    expect(result.listingsIngested).toBe(0);
    expect(result.errors.join(' ')).toMatch(/pertence ao marketplace shopee/);
    expect(db.rows<{ count: number }>('SELECT COUNT(*) AS count FROM listing_snapshots')[0]?.count).toBe(0);
  });

  it('grava snapshot com proveniência quando a conta existe', async () => {
    await call('account.upsert', {
      marketplace: 'mercado_livre',
      accountId: 'ml:conta1',
      displayName: 'Loja Teste',
      confidence: 0.9,
      verifiedByUser: true,
    });
    const r = await call('capture.ingest', payload);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const res = r.result as { ok: boolean; listingsIngested: number };
    expect(res.ok).toBe(true);
    expect(res.listingsIngested).toBe(1);

    const prov = db.rows<{ field: string; source_class: string }>('SELECT field, source_class FROM data_provenance');
    expect(prov.length).toBeGreaterThan(5);
    expect(prov.every((p) => p.source_class === 'A_PRIMARY_UI')).toBe(true);

    const kpi = (await call('kpi.listing', { listingId: db.rows<{ id: string }>('SELECT id FROM listings')[0]!.id })).result as {
      pillars: { conversion_cro: { cvr: number } };
    };
    expect((kpi.pillars.conversion_cro.cvr as unknown as { value: number }).value).toBeCloseTo(3, 5);

    const dashboard = (await call('kpi.dashboard')).result as {
      totals: { gmvCents: number; netRevenueCents: number | null; adSpendCents: number; orders: number };
    };
    expect(dashboard.totals.gmvCents).toBe(320000);
    expect(dashboard.totals.netRevenueCents).toBeNull();
    expect(dashboard.totals.adSpendCents).toBe(20000);
    expect(dashboard.totals.orders).toBe(30);
  });

  it('não apresenta subtotal como total da conta quando há anúncio sem captura', async () => {
    await call('account.upsert', {
      marketplace: 'mercado_livre',
      accountId: 'ml:conta1',
      displayName: 'Loja Teste',
      confidence: 0.9,
      verifiedByUser: true,
    });
    await call('capture.ingest', payload);
    const now = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO listings (id, account_id, marketplace, external_id, title, status, url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
    ).run('listing-without-snapshot', 'ml:conta1', 'mercado_livre', 'MLB999', 'Sem snapshot', payload.url, now, now);

    const dashboard = (await call('kpi.dashboard')).result as {
      coverage: { totalListings: number; capturedListings: number; uncapturedListings: number };
      totals: { gmvCents: number | null; orders: number | null };
    };
    expect(dashboard.coverage).toEqual({ totalListings: 2, capturedListings: 1, uncapturedListings: 1, accountsWithSnapshots: 0 });
    expect(dashboard.totals.gmvCents).toBeNull();
    expect(dashboard.totals.orders).toBeNull();
  });

  it('não sobrescreve histórico ao capturar de novo', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:conta1', displayName: 'Loja', confidence: 1, verifiedByUser: true });
    await call('capture.ingest', payload);
    await call('capture.ingest', { ...payload, collectedAt: new Date(Date.now() + 1000).toISOString() });
    const snaps = db.rows<{ c: number }>('SELECT COUNT(*) AS c FROM listing_snapshots');
    expect(snaps[0]!.c).toBe(2);
  });

  it('recusa captura inválida com relatório de qualidade', async () => {
    const r = await call('capture.ingest', { marketplace: 'x' });
    const res = r.result as { ok: boolean; errors: string[] };
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it('gera previsão linear somente com oito semanas distintas de histórico', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:forecast', displayName: 'Forecast', confidence: 1, verifiedByUser: true });
    const now = Date.now();
    const listingId = 'forecast-listing';
    db.db.prepare(`INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?)`)
      .run(listingId, 'ml:forecast', 'mercado_livre', 'MLBFORECAST', 'Produto', new Date(now).toISOString(), new Date(now).toISOString());
    const stmt = db.db.prepare('INSERT INTO listing_snapshots (id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class) VALUES (?,?,?,?,?,?,?)');
    for (let week = 0; week < 8; week += 1) {
      const at = new Date(now - (7 - week) * 7 * 86400000).toISOString();
      stmt.run(`forecast-${week}`, listingId, 'ml:forecast', at, at, JSON.stringify({ gmv: 100 + week * 10 }), 'A_PRIMARY_UI');
    }
    const forecast = await call('forecast.run', { accountId: 'ml:forecast', metric: 'gmv', horizonDays: 28 });
    const result = forecast.result as { ok: boolean; points: Array<{ value: number }>; observations: unknown[] };
    expect(result.ok).toBe(true);
    expect(result.observations).toHaveLength(8);
    expect(result.points).toHaveLength(4);
    expect(result.points[3]!.value).toBeGreaterThan(result.points[0]!.value);
  });
});

describe('tarefas e guard', () => {
  it('preenche rascunho somente no anúncio exato e registra conclusão', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:c', displayName: 'Loja', confidence: 1, verifiedByUser: true });
    const now = new Date().toISOString();
    db.db.prepare(`INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?)`)
      .run('listing-c', 'ml:c', 'mercado_livre', 'MLB1', 'Título anterior', now, now);
    const created = (await call('task.create', {
      name: 'Atualizar título', kind: 'edit_title', mode: 'DRAFT',
      typing: { mode: 'set_value', charDelayMs: 45, settleDelayMs: 0, verifyAfterTyping: true },
      items: [{ listingId: 'MLB1', marketplace: 'mercado_livre', accountId: 'ml:c', copies: 1, title: 'Título novo' }],
    })).result as { taskId: string };
    expect(created.taskId).toBeTruthy();
    const typingSaved = db.row<{ typing_json: string }>('SELECT typing_json FROM tasks WHERE id=?', created.taskId);
    expect(JSON.parse(typingSaved!.typing_json).charDelayMs).toBe(45);

    const queued = await call('task.runNow', { taskId: created.taskId });
    expect((queued.result as { status: string }).status).toBe('WAITING_BROWSER');
    const claimed = await call('task.claimNext', { marketplace: 'mercado_livre', accountId: 'ml:c', externalListingId: 'MLB1' });
    const claim = claimed.result as { item: { id: string; title: string }; externalListingId: string; claimToken: string };
    expect(claim.item.title).toBe('Título novo');
    expect(claim.externalListingId).toBe('MLB1');
    expect((await call('task.claimNext', { marketplace: 'mercado_livre', accountId: 'ml:c', externalListingId: 'MLB1' })).result).toBeNull();
    expect(db.row<{ attempts: number }>('SELECT attempts FROM task_items WHERE id=?', claim.item.id)?.attempts).toBe(1);
    const wrong = await call('task.itemResult', { itemId: claim.item.id, claimToken: claim.claimToken, ok: false, accountId: 'outra-loja', externalListingId: 'MLB1' });
    expect(wrong.ok).toBe(false);
    expect(db.row<{ status: string }>('SELECT status FROM task_items WHERE id=?', claim.item.id)?.status).toBe('PROCESSING');
    expect((await call('task.recoverDraft', { itemId: claim.item.id, accountId: 'ml:c', closedOldTabs: true })).ok).toBe(false);
    db.db.prepare("UPDATE task_items SET draft_claimed_at=? WHERE id=?").run(new Date(Date.now()-180_000).toISOString(),claim.item.id);
    expect((await call('task.recoverDraft', { itemId: claim.item.id, accountId: 'outra-loja', closedOldTabs: true })).ok).toBe(false);
    expect((await call('task.recoverDraft', { itemId: claim.item.id, accountId: 'ml:c', closedOldTabs: false })).ok).toBe(false);
    expect((await call('task.recoverDraft', { itemId: claim.item.id, accountId: 'ml:c', closedOldTabs: true })).ok).toBe(true);
    const second = (await call('task.claimNext', { marketplace: 'mercado_livre', accountId: 'ml:c', externalListingId: 'MLB1' })).result as typeof claim;
    expect(second.claimToken).not.toBe(claim.claimToken);
    expect((await call('task.itemResult', { itemId: claim.item.id, claimToken: claim.claimToken, ok: false, accountId: 'ml:c', externalListingId: 'MLB1' })).ok).toBe(false);
    const completed = await call('task.itemResult', { itemId: claim.item.id, claimToken: second.claimToken, ok: true, accountId: 'ml:c', externalListingId: 'MLB1', message: 'rascunho preenchido e verificado', baseline: { title: 'Título anterior', description: 'Descrição anterior' }, sourceUrl: 'https://vendedores.mercadolivre.com.br/vendas/anuncios/editar/MLB1' });
    expect((completed.result as { taskStatus: string }).taskStatus).toBe('COMPLETED');
    const list = (await call('task.list')).result as Array<{ status: string; listing_id: string }>;
    expect(list[0]?.status).toBe('COMPLETED');
    expect(list[0]?.listing_id).toBe('MLB1');
  });

  it('não conclui rascunho sem snapshot original vinculado à conta e ao anúncio', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:no-baseline', displayName: 'Loja', confidence: 1, verifiedByUser: true });
    const now = new Date().toISOString();
    db.db.prepare(`INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?)`)
      .run('listing-no-baseline', 'ml:no-baseline', 'mercado_livre', 'MLBNOSNAPSHOT', 'Título atual', now, now);
    const created = (await call('task.create', { name: 'Sem snapshot', kind: 'edit_title', mode: 'DRAFT', typing: { mode: 'set_value', charDelayMs: 0, settleDelayMs: 0, verifyAfterTyping: true }, items: [{ listingId: 'MLBNOSNAPSHOT', marketplace: 'mercado_livre', accountId: 'ml:no-baseline', title: 'Título proposto' }] })).result as { taskId: string };
    await call('task.runNow', { taskId: created.taskId });
    const claimed = (await call('task.claimNext', { marketplace: 'mercado_livre', accountId: 'ml:no-baseline', externalListingId: 'MLBNOSNAPSHOT' })).result as { item: { id: string }; claimToken: string };
    const result = await call('task.itemResult', { itemId: claimed.item.id, claimToken: claimed.claimToken, ok: true, accountId: 'ml:no-baseline', externalListingId: 'MLBNOSNAPSHOT', message: 'sem evidência' });
    expect(result.ok).toBe(false);
  });

  it('publica somente após aprovação de super_admin, confirmação por anúncio e prova de sucesso; prepara rollback como rascunho', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:publish', displayName: 'Loja autorizada', confidence: 1, verifiedByUser: true });
    const now = new Date().toISOString();
    db.db.prepare(`INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?)`)
      .run('listing-publish', 'ml:publish', 'mercado_livre', 'MLBPUBLISH1', 'Título original', now, now);
    const created = (await call('task.create', {
      name: 'Publicar título aprovado', kind: 'edit_title', mode: 'DRAFT',
      typing: { mode: 'set_value', charDelayMs: 0, settleDelayMs: 0, verifyAfterTyping: true },
      items: [{ listingId: 'MLBPUBLISH1', marketplace: 'mercado_livre', accountId: 'ml:publish', copies: 1, title: 'Título revisado' }],
    })).result as { taskId: string };
    await call('task.runNow', { taskId: created.taskId });
    const draft = await call('task.claimNext', { marketplace: 'mercado_livre', accountId: 'ml:publish', externalListingId: 'MLBPUBLISH1' });
    const draftClaim = draft.result as { item: { id: string }; claimToken: string };
    await call('task.itemResult', { itemId: draftClaim.item.id, claimToken: draftClaim.claimToken, ok: true, accountId: 'ml:publish', externalListingId: 'MLBPUBLISH1', message: 'rascunho preenchido', baseline: { title: 'Título original', description: 'Descrição original' }, sourceUrl: 'https://vendedores.mercadolivre.com.br/vendas/anuncios/editar/MLBPUBLISH1' });

    const refused = await call('task.approvePublish', { taskId: created.taskId, confirmation: 'SIM', reason: 'revisão concluída' });
    expect(refused.ok).toBe(false);
    const approved = await call('task.approvePublish', { taskId: created.taskId, confirmation: 'PUBLICAR 1', reason: 'título revisado e aprovado por responsável' });
    expect(approved.ok).toBe(true);
    const approval = approved.result as { approvalIds: string[]; requiresPerListingBrowserConfirmation: boolean };
    expect(approval.requiresPerListingBrowserConfirmation).toBe(true);
    db.db.prepare("INSERT INTO listing_browser_executions(id,proposal_kind,proposal_id,account_id,listing_id,external_listing_id,action,plan_json,context_json,token_hash,status,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run('busy-browser','VARIATION','busy-proposal','ml:publish','listing-publish','MLBPUBLISH1','CREATE_VARIATION','{}','{}','hash','NEEDS_VERIFICATION',now,now,now);
    expect((await call('task.claimNextPublish',{marketplace:'mercado_livre',accountId:'ml:publish',externalListingId:'MLBPUBLISH1'})).result).toBeNull();
    db.db.prepare("UPDATE listing_browser_executions SET status='CANCELLED' WHERE id=?").run('busy-browser');
    const claim = await call('task.claimNextPublish', { marketplace: 'mercado_livre', accountId: 'ml:publish', externalListingId: 'MLBPUBLISH1' });
    const publish = claim.result as { approvalId: string; task: { mode: string }; item: { id: string; baselineTitle: string; baselineDescription: string } };
    expect(publish.task.mode).toBe('PUBLISH');
    expect(publish.item.baselineTitle).toBe('Título original');
    expect(publish.item.baselineDescription).toBe('Descrição original');
    expect(publish.approvalId).toBe(approval.approvalIds[0]);
    const replay = await call('task.claimNextPublish', { marketplace: 'mercado_livre', accountId: 'ml:publish', externalListingId: 'MLBPUBLISH1' });
    expect(replay.result).toBeNull();

    const result = await call('task.publishResult', {
      approvalId: publish.approvalId, externalListingId: 'MLBPUBLISH1', outcome: 'PUBLISHED',
      after: { title: 'Título revisado', description: 'Descrição original' },
      sourceUrl: 'https://vendedores.mercadolivre.com.br/vendas/anuncios/editar/MLBPUBLISH1',
      successText: 'Alterações salvas com sucesso', saveButtonLabel: 'Salvar',
    });
    expect(result.ok).toBe(true);
    expect((result.result as any).status).toBe('PUBLISHED');
    const change = db.row<{ listing_id: string; before_text: string; after_text: string; verified_after_save: number }>(
      "SELECT listing_id,before_text,after_text,verified_after_save FROM change_sets WHERE task_id=? AND field='title'", created.taskId,
    );
    expect(change).toEqual({ listing_id: 'listing-publish', before_text: 'Título original', after_text: 'Título revisado', verified_after_save: 1 });
    const rollback = await call('task.rollbackPrepare', { approvalId: publish.approvalId });
    expect(rollback.ok).toBe(true);
    const rollbackTask = (rollback.result as { taskId: string }).taskId;
    const rollbackItem = db.row<{ title: string; status: string }>('SELECT title,status FROM task_items WHERE task_id=?', rollbackTask);
    expect(rollbackItem?.title).toBe('Título original');
    expect(rollbackItem?.status).toBe('PENDING');
    const original=db.row<{id:string;rolled_back_at:string|null}>('SELECT id,rolled_back_at FROM change_sets WHERE task_id=?',created.taskId)!;
    expect(original.rolled_back_at).toBeNull();
    expect((await call('task.rollbackPrepare',{approvalId:publish.approvalId})).ok).toBe(false);
    expect((await call('audit.rollback',{changeSetId:original.id,accountId:'wrong',confirmed:true})).ok).toBe(false);
    expect((await call('task.runNow',{taskId:rollbackTask})).ok).toBe(true);
    const restoredDraft=(await call('task.claimNext',{marketplace:'mercado_livre',accountId:'ml:publish',externalListingId:'MLBPUBLISH1'})).result as {item:{id:string};claimToken:string};
    expect(restoredDraft.item.id).toBeTruthy();
    expect((await call('task.itemResult',{itemId:restoredDraft.item.id,claimToken:restoredDraft.claimToken,ok:true,accountId:'ml:publish',externalListingId:'MLBPUBLISH1',baseline:{title:'Título revisado',description:'Descrição original'},sourceUrl:'https://vendedores.mercadolivre.com.br/vendas/anuncios/editar/MLBPUBLISH1'})).ok).toBe(true);
    expect((await call('task.approvePublish',{taskId:rollbackTask,confirmation:'PUBLICAR 1',reason:'reverter alteração revisada'})).ok).toBe(true);
    const restoredClaim=(await call('task.claimNextPublish',{marketplace:'mercado_livre',accountId:'ml:publish',externalListingId:'MLBPUBLISH1'})).result as {approvalId:string};
    expect(restoredClaim.approvalId).toBeTruthy();
    expect(db.row('SELECT rolled_back_at FROM change_sets WHERE id=?',original.id)).toMatchObject({rolled_back_at:null});
    expect((await call('task.publishResult',{approvalId:restoredClaim.approvalId,externalListingId:'MLBPUBLISH1',outcome:'PUBLISHED',after:{title:'Título original',description:'Descrição original'},sourceUrl:'https://vendedores.mercadolivre.com.br/vendas/anuncios/editar/MLBPUBLISH1',successText:'Alterações salvas com sucesso',saveButtonLabel:'Salvar'})).ok).toBe(true);
    expect(db.row('SELECT rolled_back_at FROM change_sets WHERE id=?',original.id)).toMatchObject({rolled_back_at:expect.any(String)});
    expect(db.row('SELECT verified_at FROM report_rollback_links WHERE change_set_id=?',original.id)).toMatchObject({verified_at:expect.any(String)});
  });

  it('não permite que operador reivindique publicação nem registre resultado administrativo', async () => {
    const created = await call('user.upsert', { email: 'operator-publish@local.test', displayName: 'Operador publicação', role: 'operador', password: 'senha-operador-pub-123' });
    expect(created.ok).toBe(true);
    const login = await service.handle({ id: 'operator-login-pub', protocolVersion: 1, method: 'auth.login', payload: { email: 'operator-publish@local.test', password: 'senha-operador-pub-123' } });
    const operatorToken = (login.result as { token: string }).token;
    const claim = await service.handle({ id: 'operator-publish-claim', protocolVersion: 1, method: 'task.claimNextPublish', payload: { marketplace: 'mercado_livre', accountId: 'ml:publish', externalListingId: 'MLBPUBLISH1' }, token: operatorToken });
    const result = await service.handle({ id: 'operator-publish-result', protocolVersion: 1, method: 'task.publishResult', payload: { approvalId: 'approval-forgery', externalListingId: 'MLBPUBLISH1', outcome: 'PUBLISHED' }, token: operatorToken });
    expect(claim.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('escopa a reivindicação de rascunho à conta exata, mesmo com IDs externos duplicados em lojas diferentes', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:account-a', displayName: 'A', confidence: 1, verifiedByUser: true });
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:account-b', displayName: 'B', confidence: 1, verifiedByUser: true });
    const now = new Date().toISOString();
    for (const [id,account] of [['listing-a','ml:account-a'],['listing-b','ml:account-b']] as const) {
      db.db.prepare(`INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?)`)
        .run(id,account,'mercado_livre','MLBDUPLICATED','Título',now,now);
    }
    const created = (await call('task.create', { name:'Conta A',kind:'edit_title',mode:'DRAFT',typing:{mode:'set_value',charDelayMs:0,settleDelayMs:0,verifyAfterTyping:true},items:[{listingId:'MLBDUPLICATED',marketplace:'mercado_livre',accountId:'ml:account-a',title:'A título'}]})).result as {taskId:string};
    await call('task.runNow',{taskId:created.taskId});
    const wrong = await call('task.claimNext',{marketplace:'mercado_livre',accountId:'ml:account-b',externalListingId:'MLBDUPLICATED'});
    expect(wrong.result).toBeNull();
    const right = await call('task.claimNext',{marketplace:'mercado_livre',accountId:'ml:account-a',externalListingId:'MLBDUPLICATED'});
    expect((right.result as any).item.title).toBe('A título');
  });

  it('fecha a tarefa corretamente quando o usuário pula o último item', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:skip', displayName: 'Loja', confidence: 1, verifiedByUser: true });
    const now = new Date().toISOString();
    db.db.prepare(`INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?)`)
      .run('listing-skip', 'ml:skip', 'mercado_livre', 'MLBSKIP1', 'Título', now, now);
    const created = (await call('task.create', {
      name: 'Pular tarefa', kind: 'edit_title', mode: 'DRAFT',
      typing: { mode: 'set_value', charDelayMs: 0, settleDelayMs: 0, verifyAfterTyping: true },
      items: [{ listingId: 'MLBSKIP1', marketplace: 'mercado_livre', accountId: 'ml:skip', title: 'Novo título' }],
    })).result as { taskId: string };
    const skipped = await call('task.skipItem', { taskId: created.taskId });
    expect(skipped.ok).toBe(true);
    const listed = (await call('task.list', { accountId: 'ml:skip' })).result as Array<{ status: string }>;
    expect(listed[0]?.status).toBe('COMPLETED');
  });

  it('permite retentar manualmente itens esgotados de uma tarefa FAILED', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:retry', displayName: 'Loja', confidence: 1, verifiedByUser: true });
    const now = new Date().toISOString();
    db.db.prepare(`INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?)`)
      .run('listing-retry', 'ml:retry', 'mercado_livre', 'MLBRETRY1', 'Título', now, now);
    const created = (await call('task.create', {
      name: 'Retentar tarefa', kind: 'edit_title', mode: 'DRAFT',
      typing: { mode: 'set_value', charDelayMs: 0, settleDelayMs: 0, verifyAfterTyping: true },
      items: [{ listingId: 'MLBRETRY1', marketplace: 'mercado_livre', accountId: 'ml:retry', title: 'Novo título' }],
    })).result as { taskId: string };
    db.db.prepare("UPDATE tasks SET status='FAILED' WHERE id=?").run(created.taskId);
    db.db.prepare("UPDATE task_items SET status='FAILED',attempts=3,last_error='falhou' WHERE task_id=?").run(created.taskId);
    const run = await call('task.runNow', { taskId: created.taskId });
    expect((run.result as { status: string }).status).toBe('WAITING_BROWSER');
    const item = db.row<{ status: string; attempts: number }>('SELECT status,attempts FROM task_items WHERE task_id=?', created.taskId);
    expect(item).toEqual({ status: 'PENDING', attempts: 0 });
  });

  it('impede que uma tarefa de título altere também a descrição', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:kind', displayName: 'Loja', confidence: 1, verifiedByUser: true });
    const now = new Date().toISOString();
    db.db.prepare(`INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?)`)
      .run('listing-kind', 'ml:kind', 'mercado_livre', 'MLBKIND1', 'Título', now, now);
    const result = await call('task.create', {
      name: 'Tarefa isolada', kind: 'edit_title', mode: 'DRAFT',
      typing: { mode: 'set_value', charDelayMs: 0, settleDelayMs: 0, verifyAfterTyping: true },
      items: [{ listingId: 'MLBKIND1', marketplace: 'mercado_livre', accountId: 'ml:kind', title: 'Novo', descriptionAdditions: 'Mudança extra' }],
    });
    expect(result.ok).toBe(false);
  });

  it('cria rascunhos por filtro apenas para anúncios com métricas completas na conta selecionada', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:filtered', displayName: 'Loja filtrada', confidence: 1, verifiedByUser: true });
    const now = new Date().toISOString();
    const listingInsert = db.db.prepare(`INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?)`);
    listingInsert.run('filtered-match', 'ml:filtered', 'mercado_livre', 'MLBFILTER1', 'Título A', now, now);
    listingInsert.run('filtered-missing', 'ml:filtered', 'mercado_livre', 'MLBFILTER2', 'Título B', now, now);
    db.db.prepare('INSERT INTO listing_snapshots (id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class) VALUES (?,?,?,?,?,?,?)')
      .run('filtered-snap-1', 'filtered-match', 'ml:filtered', now, now, JSON.stringify({ gmv: 500, orders: 10, visits: 100, stockAvailable: 2 }), 'A_PRIMARY_UI');
    db.db.prepare('INSERT INTO listing_snapshots (id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class) VALUES (?,?,?,?,?,?,?)')
      .run('filtered-snap-2', 'filtered-missing', 'ml:filtered', now, now, JSON.stringify({ gmv: 900 }), 'A_PRIMARY_UI');
    const response = await call('task.createByFilter', {
      name: 'Baixa cobertura de estoque', accountId: 'ml:filtered', kind: 'edit_title', draftTitle: 'Revisado: {title}',
      filters: { minGmv: 400, minOrders: 5, maxStockAvailable: 3 },
    });
    expect(response.ok).toBe(true);
    const result = response.result as { created: boolean; matched: number; taskId: string };
    expect(result.created).toBe(true);
    expect(result.matched).toBe(1);
    const items = db.rows<{ listing_id: string; title: string }>('SELECT listing_id,title FROM task_items WHERE task_id=?', result.taskId);
    expect(items).toEqual([{ listing_id: 'filtered-match', title: 'Revisado: Título A' }]);
  });

  it('bloqueia publicação e tipo de tarefa sem executor', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:c', displayName: 'Loja', confidence: 1, verifiedByUser: true });
    const now = new Date().toISOString();
    db.db.prepare(`INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,'ACTIVE',?,?)`)
      .run('listing-c', 'ml:c', 'mercado_livre', 'MLB1', 'Título anterior', now, now);
    const base = { name: 'Teste', kind: 'edit_title', typing: { mode: 'set_value', charDelayMs: 0, settleDelayMs: 0, verifyAfterTyping: true }, items: [{ listingId: 'MLB1', marketplace: 'mercado_livre', accountId: 'ml:c', title: 'Novo' }] };
    const publish = await call('task.create', { ...base, mode: 'PUBLISH' });
    expect(publish.ok).toBe(false);
    const duplicate = await call('task.create', { ...base, kind: 'duplicate', mode: 'DRAFT' });
    expect(duplicate.ok).toBe(false);
    const unsupportedMarketplace = await call('task.create', { ...base, items: [{ ...base.items[0], marketplace: 'amazon' }] });
    expect(unsupportedMarketplace.ok).toBe(false);
  });

  const guardBase = {
    action: 'edit_description' as const,
    marketplace: { id: 'mercado_livre', enabled: true },
    account: { id: 'ml:conta1', marketplace: 'mercado_livre', sessionState: 'AUTHENTICATED', verified: true },
    listing: { id: 'L1', accountId: 'ml:conta1', externalId: 'MLB1', status: 'ACTIVE' },
    currentState: { title: 'Fone', description: 'Texto original longo do vendedor' },
    financialLimits: null,
    requiredData: { missing: [] as string[] },
    platformRules: { violations: [] as string[] },
    authorization: { approved: true, approvedBy: 'admin' },
    conflicts: [] as string[],
  };

  it('guard bloqueia quando a sessão está em CAPTCHA', () => {
    const d = evaluateGuard({
      ...guardBase,
      actorRole: 'super_admin',
      account: { ...guardBase.account, sessionState: 'CHALLENGE_REQUIRED' },
    });
    expect(d.allowed).toBe(false);
    expect(d.blockedReasons.join(' ')).toMatch(/sess/i);
  });

  it('guard registra as 10 verificações com detalhe legível por perfil', () => {
    const visualizador = evaluateGuard({ ...guardBase, actorRole: 'visualizador' });
    const admin = evaluateGuard({ ...guardBase, actorRole: 'super_admin' });
    expect(visualizador.allowed).toBe(false);
    expect(visualizador.blockedReasons.length).toBeGreaterThan(0);
    expect(admin.checks.length).toBe(GUARD_CHECKS.length);
    expect(admin.checks.every((c) => c.detail.length > 0)).toBe(true);
    expect(admin.checks.find((c) => c.check === 'user_permission')?.detail).toContain('super_admin');
  });

  it('guard bloqueia quando faltam dados obrigatórios', () => {
    const d = evaluateGuard({ ...guardBase, actorRole: 'super_admin', requiredData: { missing: ['price'] } });
    expect(d.allowed).toBe(false);
    expect(d.blockedReasons.join(' ')).toMatch(/dado/i);
  });

  it('guard bloqueia violação de regra da plataforma', () => {
    const d = evaluateGuard({ ...guardBase, actorRole: 'super_admin', platformRules: { violations: ['promessa de cura'] } });
    expect(d.allowed).toBe(false);
  });

  it('expõe as 10 verificações do guard', () => {
    expect(GUARD_CHECKS.length).toBe(10);
  });
});

describe('segredos e Gemini', () => {
  it('não substitui uma chave local existente mas inválida', () => {
    const keyDir = join(dir, 'invalid-key');
    mkdirSync(keyDir);
    const key = join(keyDir, 'master.key');
    writeFileSync(key, 'inválida');
    expect(() => loadMachineSecret(keyDir)).toThrow(/chave local inválida/);
    expect(readFileSync(key, 'utf8')).toBe('inválida');
  });

  it.skipIf(process.platform === 'win32')('protege permissões e recusa symlink para a chave', () => {
    const keyDir = join(dir, 'secure-key');
    const first = loadMachineSecret(keyDir);
    const key = join(keyDir, 'master.key');
    chmodSync(key, 0o644);
    expect(loadMachineSecret(keyDir).secret.equals(first.secret)).toBe(true);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    const other = join(dir, 'symlink-key');
    mkdirSync(other);
    symlinkSync(key, join(other, 'master.key'));
    expect(() => loadMachineSecret(other)).toThrow(/arquivo regular/);
  });

  it.skipIf(process.platform === 'win32')('não cria chave portátil se já existe arquivo DPAPI', () => {
    const keyDir = join(dir, 'dpapi-key');
    mkdirSync(keyDir);
    writeFileSync(join(keyDir, 'master.key.dpapi'), 'chave existente');
    expect(() => loadMachineSecret(keyDir)).toThrow(/DPAPI existente/);
  });

  it('cifra e decifra segredo com roundtrip', () => {
    const store = new SecretStore(db, join(dir, 'sec2'));
    store.set('gemini.apiKey', 'chave-secreta-de-teste-123456');
    store.set('connector:conta-a:access_token', 'token-privado-a');
    store.set('connector:conta-a:refresh_token', 'refresh-privado-a');
    store.set('connector:conta-b:access_token', 'token-privado-b');
    expect(store.get('gemini.apiKey')).toBe('chave-secreta-de-teste-123456');
    expect(store.deletePrefix('connector:conta-a:')).toBe(2);
    expect(store.get('connector:conta-a:access_token')).toBeNull();
    expect(store.get('connector:conta-b:access_token')).toBe('token-privado-b');
    expect(store.get('inexistente')).toBeNull();
  });

  it('não devolve a chave do Gemini para a UI', async () => {
    const r = await call('gemini.setKey', { apiKey: 'AIzaSyTesteChaveComTamanhoSuficiente123' });
    expect((r.result as { ok: boolean }).ok).toBe(true);
    const hint = (r.result as { hint: string }).hint;
    expect(hint).not.toContain('AIzaSyTesteChaveComTamanhoSuficiente123');
    const budget = (await call('agent.budget')).result as { geminiConfigured: boolean };
    expect(budget.geminiConfigured).toBe(true);
  });

  it('bloqueia gravação de segredo via settings', async () => {
    const r = await call('settings.set', { key: 'gemini_apiKey', value: 'x' });
    expect(r.ok).toBe(false);
  });

  it('client sem chave retorna NO_KEY sem chamar rede', async () => {
    const c = new GeminiClient(db, new SecretStore(db, join(dir, 'sec3')), async () => ({ ok: false, status: 200, json: {} }));
    const res = await c.call({ agentKey: 'x', model: 'gemini-2.5-flash', systemPrompt: 's', userContent: 'u' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('NO_KEY');
  });

  it('client respeita orçamento diário', async () => {
    const c = new GeminiClient(db, new SecretStore(db, join(dir, 'sec4')), async () => ({
      ok: true,
      status: 200,
      json: { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
    }));
    c.setKey('AIzaSyTesteChaveComTamanhoSuficiente123');
    const res = await c.call({
      agentKey: 'x',
      model: 'gemini-2.5-flash',
      systemPrompt: 's',
      userContent: 'u',
      budget: { dailyCostLimitUsd: 0 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(['BUDGET_EXCEEDED', 'HTTP_ERROR']).toContain(res.errorCode);
  });
});

describe('adapters', () => {
  it('resolve adapter por URL e ignora domínio desconhecido', () => {
    expect(adapterForUrl('https://www.mercadolivre.com.br/vendas')?.id).toBe('mercado_livre');
    expect(adapterForUrl('https://seller.shopee.com.br/portal/product/list')?.id).toBe('shopee');
    expect(adapterForUrl('https://exemplo.com')).toBeNull();
  });

  it('detecta página de edição e de desafio', () => {
    expect(mercadoLivreAdapter.detectPage('https://www.mercadolivre.com.br/vendas/anuncios/editar/MLB1', [])?.kind).toBe('seller_listing_edit');
    expect(mercadoLivreAdapter.detectPage('https://www.mercadolivre.com.br/captcha', [])?.kind).toBe('challenge');
  });

  it('detecta sessão autenticada com conta', () => {
    const s = mercadoLivreAdapter.detectSession('https://www.mercadolivre.com.br/vendas', ['seller-nav', 'nickname:LOJATESTE']);
    expect(s.state).toBe('AUTHENTICATED');
    expect(s.account?.handle).toBe('LOJATESTE');
  });

  it('marca sessão como desafio quando há captcha', () => {
    expect(shopeeAdapter.detectSession('https://seller.shopee.com.br/', ['captcha']).state).toBe('CHALLENGE_REQUIRED');
  });

  it('diagnostica mudança de layout', () => {
    const d = mercadoLivreAdapter.diagnose({ listing_title_input: 1, listing_price_input: 0, listing_stock_input: 0 });
    expect(d.layoutChangedSuspected).toBe(true);
  });

  it('lista capacidades não suportadas honestamente', () => {
    expect(unsupportedCapabilities(mercadoLivreAdapter)).toContain('title_edit');
    expect(unsupportedCapabilities(mercadoLivreAdapter)).toContain('price_edit');
    expect(unsupportedCapabilities(shopeeAdapter)).toContain('image_upload');
  });
});

describe('voz do cliente e privacidade', () => {
  it('redige dados pessoais', () => {
    const out = redactPII('meu email joao@teste.com e telefone (11) 98888-7777 e cpf 123.456.789-09');
    expect(out).not.toContain('joao@teste.com');
    expect(out).not.toContain('98888');
    expect(out).not.toContain('123.456');
  });

  it('grava avaliação já redigida', async () => {
    await call('account.upsert', { marketplace: 'mercado_livre', accountId: 'ml:c', displayName: 'Loja', confidence: 1, verifiedByUser: true });
    const r = await call('voc.ingest', { accountId: 'ml:c', kind: 'REVIEW', text: 'Chegou antes do prazo, contato joao@teste.com', rating: 5 });
    expect((r.result as { ok: boolean }).ok).toBe(true);
    const row = db.rows<{ text_redacted: string }>('SELECT text_redacted FROM customer_voice_items');
    expect(row[0]!.text_redacted).not.toContain('joao@teste.com');
  });
});

describe('financeiro e missões', () => {
  it('simula cenário e devolve margem', async () => {
    const r = await call('finance.simulate', {
      priceCents: 10000,
      quantity: 10,
      commissionPct: 14,
      fixedFeeCents: 600,
      unitCostCents: 4000,
      taxPct: 8,
      minMarginPct: 20,
    });
    const res = r.result as { netRevenueCents: number; contributionMarginPct: number };
    expect(res.netRevenueCents).toBeGreaterThan(0);
    expect(res.contributionMarginPct).toBeGreaterThan(0);
  });

  it('versiona custos em vez de sobrescrever', async () => {
    db.db
      .prepare("INSERT INTO skus (id, sku_code, created_at) VALUES ('SKU1', 'SKU1', ?)")
      .run(new Date().toISOString());
    const ra = await call('finance.costs.upsert', { skuId: 'SKU1', unitCostCents: 1000 });
    if (!ra.ok) throw new Error(JSON.stringify(ra.error));
    const a = ra.result as { version: number };
    const rb = await call('finance.costs.upsert', { skuId: 'SKU1', unitCostCents: 1100 });
    if (!rb.ok) throw new Error(JSON.stringify(rb.error));
    const b = rb.result as { version: number };
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
    expect(db.rows<{ c: number }>('SELECT COUNT(*) AS c FROM sku_costs')[0]!.c).toBe(2);
  });
});

describe('agentes', () => {
  it('devolve síntese com recomendações, conflitos e notas', async () => {
    const r = await call('agent.run', {
      agents: ['seo_demand', 'finance'],
      context: {
        accountId: 'ml:conta1',
        marketplace: 'mercado_livre',
        listingId: 'MLB1',
        window: { start: new Date(Date.now() - 30 * 86400000).toISOString(), end: new Date().toISOString(), days: 30 },
        metrics: { keywordCoveragePct: 42, attributeCompletenessPct: 55, contributionMarginPct: -5 },
        missingData: ['posição média', 'ads'],
      },
    });
    expect(r.ok).toBe(true);
    const res = r.result as { recommendations: unknown[]; conflicts: Array<{ resolution: string }>; notes: string[] };
    expect(Array.isArray(res.recommendations)).toBe(true);
    expect(Array.isArray(res.conflicts)).toBe(true);
    expect(Array.isArray(res.notes)).toBe(true);
    // prevalência financeira: margem negativa impede recomendações de tráfego (§29.4)
    expect(res.notes.join(' ')).toMatch(/margem negativa/i);
    expect(res.conflicts.length).toBeGreaterThan(0);
  });
});

describe('backup', () => {
  it('cria backup pela API e audita', async () => {
    const r = await call('backup.create', { note: 'antes da migração' });
    expect((r.result as { ok: boolean }).ok).toBe(true);
    const audit = db.rows<{ action: string }>("SELECT action FROM audit_log WHERE action = 'BACKUP_CREATE'");
    expect(audit.length).toBe(1);
  });
});


describe('segurança de caminhos do auto-upgrade', () => {
  it.each(['../secrets.env', '../../outside.ts', '/etc/passwd', 'C:\\Windows\\win.ini', '\\\\server\\share\\file.ts'])(
    'recusa o caminho inseguro %s', (target) => {
      const diff = `diff --git a/safe.ts b/${target}\n--- a/safe.ts\n+++ b/${target}\n@@ -1 +1 @@\n-old\n+new\n`;
      expect(() => extractTargetPaths(diff)).toThrow(/caminho de patch/);
    },
  );

  it('não chama reader nem writer quando o diff contém traversal', () => {
    let reads = 0;
    let writes = 0;
    const diff = [
      'diff --git a/../../secret.txt b/../../secret.txt',
      '--- a/../../secret.txt',
      '+++ b/../../secret.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    const result = applyUnifiedDiff(diff, () => { reads += 1; return 'old'; }, () => { writes += 1; });
    expect(result.errors.join(' ')).toMatch(/caminho de patch/);
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  it('valida todos os hunks antes de gravar qualquer arquivo', () => {
    const diff = [
      'diff --git a/first.ts b/first.ts',
      '--- a/first.ts',
      '+++ b/first.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/second.ts b/second.ts',
      '--- a/second.ts',
      '+++ b/second.ts',
      '@@ -1 +1 @@',
      '-expected',
      '+new',
      '',
    ].join('\n');
    const writes: string[] = [];
    const result = applyUnifiedDiff(diff, (path) => path === 'first.ts' ? 'old' : 'actual', (path) => writes.push(path));
    expect(result.errors.join(' ')).toMatch(/contexto do hunk não corresponde/);
    expect(writes).toEqual([]);
    expect(result.appliedFiles).toEqual([]);
  });
});

describe('analytics, keyword intelligence and bundle simulation', () => {
  it('returns daily KPI history using the latest snapshot per listing/day and preserves null coverage', async () => {
    seedImportAccount('acct-history');
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
    db.db.prepare('INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('history-listing','acct-history','mercado_livre','ML-HISTORY','Capacete histórico','ACTIVE',now.toISOString(),now.toISOString());
    const insert = db.db.prepare('INSERT INTO listing_snapshots (id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class) VALUES (?,?,?,?,?,?,?)');
    insert.run('h1','history-listing','acct-history',`${today}T09:00:00.000Z`,`${today}T09:00:00.000Z`,JSON.stringify({gmv:100,orders:2}),'A_PRIMARY_UI');
    insert.run('h2','history-listing','acct-history',`${today}T12:00:00.000Z`,`${today}T12:00:00.000Z`,JSON.stringify({gmv:150,orders:3}),'A_PRIMARY_UI');
    insert.run('h3','history-listing','acct-history',`${yesterday}T12:00:00.000Z`,`${yesterday}T12:00:00.000Z`,JSON.stringify({visits:30}),'A_PRIMARY_UI');
    const response = await call('kpi.history',{accountId:'acct-history',days:30});
    expect(response.ok).toBe(true);
    const result = response.result as {points:Array<Record<string,unknown>>;missingValues:string};
    expect(result.points).toHaveLength(2);
    const current = result.points.find((point)=>point.date===today)!;
    expect(current.gmv).toBe(150);
    expect(current.orders).toBe(3);
    expect(current.visits).toBeNull();
    expect(result.missingValues).toBe('null_not_zero');
  });

  it('aggregates daily history by account before combining stores, without cross-account overrides', async () => {
    const a='history-multi-a',b='history-multi-b';
    const day=new Date(Date.now()-20*86400000).toISOString().slice(0,10);
    const at=day+'T12:00:00.000Z';
    const account=db.db.prepare('INSERT INTO accounts (id,marketplace,external_ref,display_name,handle,detection_confidence,verified_by_user,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    account.run(a,'amazon',a,a,a,1,1,1,at,at);
    account.run(b,'amazon',b,b,b,1,1,1,at,at);
    for(const id of [a,b]){
      db.db.prepare('INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id+'-listing',id,'amazon',id+'-external',id,'ACTIVE',at,at);
      db.db.prepare('INSERT INTO listing_snapshots (id,listing_id,account_id,captured_at,reference_at,metrics_json,source_class) VALUES (?,?,?,?,?,?,?)').run(id+'-snapshot',id+'-listing',id,at,at,JSON.stringify(id===a?{gmv:10,orders:1}:{gmv:20,orders:2}),'A_PRIMARY_UI');
    }
    const observed=await call('capture.ingest',{marketplace:'amazon',accountId:a,pageKind:'seller_dashboard',url:'https://sellercentral.amazon.com.br/home',sourceClass:'A_PRIMARY_UI',referenceAt:at,collectedAt:at,method:'content_script_dom',accountMetrics:{gmv:100,visits:90}});
    expect(observed.ok).toBe(true);
    const result=await call('kpi.history',{marketplace:'amazon',days:30});
    expect(result.ok).toBe(true);
    const point=(result.result as {points:Array<Record<string,unknown>>}).points.find(p=>p.date===day);
    expect(point).toMatchObject({gmv:120,orders:3,visits:null,accountsCaptured:2,gmvCoverage:2,visitsCoverage:1});
    const scope={marketplace:'amazon',accountId:a,listingId:a+'-listing',days:30};
    const dashboard=await call('kpi.dashboard',scope);
    expect(dashboard.result).toMatchObject({totals:{gmvCents:1000},window:{entityScoped:true,days:30},coverage:{totalListings:1,accountsWithSnapshots:0}});
    const scopedHistory=await call('kpi.history',scope);
    expect(scopedHistory.result).toMatchObject({points:[{gmv:10,orders:1,accountsCaptured:1,aovCents:1000,cvr:null}]});
    const recent=await call('kpi.dashboard',{...scope,days:7});
    expect(recent.result).toMatchObject({totals:{gmvCents:null},coverage:{capturedListings:0}});
    expect((await call('kpi.history',{...scope,days:7})).result).toMatchObject({points:[]});

  });

  it('suggests local title phrases without claiming search volume', async () => {
    const now = new Date().toISOString();
    seedImportAccount('acct-keywords');
    db.db.prepare('INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('kwl1','acct-keywords','mercado_livre','ML-KW1','Capacete Norisk FF302 Fechado Preto','ACTIVE',now,now);
    db.db.prepare('INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('kwl2','acct-keywords','mercado_livre','ML-KW2','Capacete Norisk FF302 Fosco','ACTIVE',now,now);
    const response=await call('keyword.suggest',{accountId:'acct-keywords',limit:50});
    expect(response.ok).toBe(true);
    const rows=response.result as Array<{term:string;source:string;note:string}>;
    expect(rows.some((row)=>row.term==='capacete norisk')).toBe(true);
    expect(rows[0]?.source).toBe('LOCAL_CATALOG_TITLES');
    expect(rows[0]?.note).toContain('não representa volume de busca');
  });

  it('clusters similar keyword phrases and detects cannibalized listings', async () => {
    const now=new Date().toISOString();
    seedImportAccount('acct-cluster');
    for (const [id,external,title] of [['cl1','ML-CL1','Capacete Norisk FF302'],['cl2','ML-CL2','Norisk FF302 Fechado']] as const) {
      db.db.prepare('INSERT INTO listings (id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,'acct-cluster','mercado_livre',external,title,'ACTIVE',now,now);
    }
    db.db.prepare('INSERT INTO keywords (id,term,normalized,intent,marketplace,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('kwc1','capacete norisk ff302','capacete norisk ff302','PRODUTO_DIRETO','mercado_livre',now,now);
    db.db.prepare('INSERT INTO keywords (id,term,normalized,intent,marketplace,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('kwc2','norisk ff302 fechado','norisk ff302 fechado','PRODUTO_DIRETO','mercado_livre',now,now);
    const clustered=await call('keyword.cluster',{marketplace:'mercado_livre',threshold:0.25});
    expect(clustered.ok).toBe(true);
    expect((clustered.result as {clustersCreated:number}).clustersCreated).toBeGreaterThan(0);
    db.db.prepare('INSERT INTO rank_observations (listing_id,keyword_id,position,is_sponsored,observed_at,context_json) VALUES (?,?,?,?,?,?)').run('cl1','kwc1',4,0,now,'{}');
    db.db.prepare('INSERT INTO rank_observations (listing_id,keyword_id,position,is_sponsored,observed_at,context_json) VALUES (?,?,?,?,?,?)').run('cl2','kwc1',9,0,now,'{}');
    const cannibal=await call('keyword.cannibalization',{accountId:'acct-cluster',days:90});
    expect(cannibal.ok).toBe(true);
    expect((cannibal.result as Array<{keywordId:string}>).some((row)=>row.keywordId==='kwc1')).toBe(true);
  });

  it('calculates observed SERP visibility only from captured results', async () => {
    const now=new Date().toISOString();
    seedImportAccount('acct-vis');
    db.db.prepare('INSERT INTO search_snapshots (id,marketplace,account_id,term,captured_at,results_count) VALUES (?,?,?,?,?,?)').run('serp1','mercado_livre','acct-vis','capacete norisk',now,3);
    const result=db.db.prepare('INSERT INTO search_results (snapshot_id,position,external_id,title,is_sponsored,is_own) VALUES (?,?,?,?,?,?)');
    result.run('serp1',1,'ML-OWN','Meu anúncio',0,1);
    result.run('serp1',2,'ML-C1','Concorrente 1',0,0);
    result.run('serp1',3,'ML-C2','Concorrente 2',0,0);
    const snapshot=db.db.prepare('INSERT INTO search_snapshots (id,marketplace,account_id,term,captured_at,results_count) VALUES (?,?,?,?,?,?)');
    snapshot.run('serp-empty','mercado_livre','acct-vis','capacete norisk',now,0);
    snapshot.run('serp-ambiguous','mercado_livre','acct-vis','capacete norisk',now,2);
    result.run('serp-ambiguous',1,'ML-C3','Concorrente 3',0,0);
    result.run('serp-ambiguous',1,'ML-C4','Concorrente 4',0,0);
    const response=await call('keyword.visibility',{accountId:'acct-vis',days:30});
    expect(response.ok).toBe(true);
    const terms=(response.result as {terms:Array<{term:string;top3PresencePct:number;ownVisibilitySharePct:number}>}).terms;
    expect(response.result).toMatchObject({snapshots:3,excludedSnapshots:2,terms:[{sampleSize:1}]});
    expect(terms[0]?.top3PresencePct).toBe(100);
    expect(terms[0]?.ownVisibilitySharePct).toBeGreaterThan(0);
    expect((response.result as {note:string}).note).toContain('não é market share');
  });

  it('simulates a multi-component bundle with aggregated costs and margin', async () => {
    const response=await call('finance.bundle.simulate',{
      bundleDiscountPct:5,adSpendCents:1000,
      components:[{name:'Produto A',priceCents:10000,quantity:1,unitCostCents:4000,commissionPct:10,fixedFeeCents:100,taxPct:5}],
    });
    expect(response.ok).toBe(true);
    const result=response.result as {total:Record<string,number> & {contributionCents:number};components:Array<Record<string,unknown>>};
    expect(result.components).toHaveLength(1);
    expect(result.total.componentCount).toBe(1);
    expect(result.total.adSpendCents).toBe(1000);
    expect(result.total.operatingProfitCents).toBe(result.total.contributionCents-1000);
  });
});


describe('feedback de agentes com evidência de resultado', () => {
  it('exige métricas observadas ao marcar uma recomendação como implementada', async () => {
    const now=new Date().toISOString();
    seedImportAccount('acct-feedback');
    db.db.prepare('INSERT INTO agent_runs (id,agent_key,account_id,started_at,finished_at,status,trigger) VALUES (?,?,?,?,?,?,?)')
      .run('run-feedback','seo_demand','acct-feedback',now,now,'OK','TEST');
    db.db.prepare(`INSERT INTO agent_recommendations (id,agent_run_id,account_id,diagnosis,evidence_json,window,facts_json,hypotheses_json,confidence,missing_data_json,risk,guardrail_metric,action_proposed,alternative,requires_approval,required_permission,verification_criteria,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('rec-feedback','run-feedback','acct-feedback','CVR baixa','[]','30d','[]','[]',0.7,'[]','risco','margem','Ajustar título e monitorar','Completar atributos',1,'edit_listing','comparar CVR em 7 dias','PROPOSTA',now);
    const response=await call('agent.feedback',{recommendationId:'rec-feedback',decision:'IMPLEMENTADO'});
    expect(response.ok).toBe(false);
    expect(String(response.error?.message || '')).toContain('métricas de antes/depois');
  });

  it('cria playbook somente após três resultados positivos medidos', async () => {
    const now=new Date().toISOString();
    seedImportAccount('acct-feedback-many');
    for(let index=1;index<=3;index++){
      const runId=`run-feedback-${index}`,recId=`rec-feedback-${index}`;
      db.db.prepare('INSERT INTO agent_runs (id,agent_key,account_id,started_at,finished_at,status,trigger) VALUES (?,?,?,?,?,?,?)')
        .run(runId,'seo_demand','acct-feedback-many',now,now,'OK','TEST');
      db.db.prepare(`INSERT INTO agent_recommendations (id,agent_run_id,account_id,diagnosis,evidence_json,window,facts_json,hypotheses_json,confidence,missing_data_json,risk,guardrail_metric,action_proposed,alternative,requires_approval,required_permission,verification_criteria,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(recId,runId,'acct-feedback-many','CVR baixa','[]','30d','[]','[]',0.7,'[]','risco','margem','Ajustar título e monitorar','Completar atributos',1,'edit_listing','comparar CVR em 7 dias','PROPOSTA',now);
      const response=await call('agent.feedback',{recommendationId:recId,decision:'IMPLEMENTADO',outcome:{success:true,measuredAt:now,baseline:{orders:10},after:{orders:12},sampleSize:100,source:'A_PRIMARY_UI'}});
      expect(response.ok).toBe(true);
      if(index<3) expect((response.result as {playbook:null}).playbook).toBeNull();
      else expect((response.result as {playbook:{successes:number}}).playbook.successes).toBe(3);
    }
    expect(db.row<{count:number}>('SELECT COUNT(*) AS count FROM validated_playbooks')?.count).toBe(1);
    const replay=await call('agent.feedback',{recommendationId:'rec-feedback-3',decision:'IMPLEMENTADO',outcome:{success:true,measuredAt:now,baseline:{orders:10},after:{orders:12},sampleSize:100,source:'A_PRIMARY_UI'}});
    expect(replay.result).toMatchObject({playbook:{successes:3,attempts:3}});
    expect(db.row<{count:number}>('SELECT COUNT(*) AS count FROM human_feedback')?.count).toBe(3);
    await call('agent.feedback',{recommendationId:'rec-feedback-3',decision:'FALHOU',outcome:{success:false,measuredAt:now,baseline:{orders:10},after:{orders:8},sampleSize:100,source:'A_PRIMARY_UI'}});
    expect(db.row('SELECT observation_status,uses FROM validated_playbooks')).toMatchObject({observation_status:'INSUFFICIENT_OBSERVATIONS',uses:3});
  });
});


describe('dashboard consolida snapshots agregados da conta sem duplicar anúncios', () => {
  it('usa métricas agregadas de dashboard e Ads no resumo da conta e no consolidado', async () => {
    seedImportAccount('acct-dashboard-a');
    seedImportAccount('acct-dashboard-b');
    const at = new Date().toISOString();
    const ingest = async (accountId: string, pageKind: 'seller_dashboard'|'seller_ads', urlPath: string, metrics: Record<string,number>) => {
      const result = await call('capture.ingest', {
        marketplace: 'mercado_livre', accountId, pageKind,
        url: `https://www.mercadolivre.com.br/${urlPath}`, sourceClass: 'A_PRIMARY_UI',
        referenceAt: at, collectedAt: at, method: 'content_script_dom', listings: [], accountMetrics: metrics,
      });
      expect(result.ok).toBe(true);
    };
    await ingest('acct-dashboard-a','seller_dashboard','vendas/metricas',{gmv:1200,netRevenue:1080,visits:600,orders:30,units:35});
    await ingest('acct-dashboard-a','seller_ads','anuncios/publicidade',{adSpend:100,adAttributedRevenue:450});
    await ingest('acct-dashboard-b','seller_dashboard','vendas/metricas',{gmv:800,netRevenue:720,visits:400,orders:20,units:22});
    await ingest('acct-dashboard-b','seller_ads','anuncios/publicidade',{adSpend:80,adAttributedRevenue:320});
    const response = await call('kpi.dashboard');
    expect(response.ok).toBe(true);
    const result = response.result as { totals:Record<string,unknown>; byAccount:Array<{id:string;totals:Record<string,unknown>;coverage:{accountSnapshotMetricCount:number}}> };
    expect(result.byAccount).toHaveLength(2);
    expect(result.byAccount.find((row)=>row.id==='acct-dashboard-a')?.totals.gmvCents).toBe(120000);
    expect(result.byAccount.find((row)=>row.id==='acct-dashboard-a')?.totals.adSpendCents).toBe(10000);
    expect(result.totals.gmvCents).toBe(200000);
    expect(result.totals.adSpendCents).toBe(18000);
    expect(result.totals.orders).toBe(50);
  });
});


describe('relatórios e conectores com estado honesto', () => {
  it.each([
    ['google_analytics4', 'GOOGLE_ANALYTICS4', { propertyId: '12345' }, 'https://analyticsdata.googleapis.com/v1beta/properties/12345/metadata', { name: 'properties/12345/metadata' }],
    ['google_search_console', 'GOOGLE_SEARCH_CONSOLE', { siteUrl: 'sc-domain:fixture.test' }, 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Afixture.test', { siteUrl: 'sc-domain:fixture.test' }],
  ] as const)('verifica $0 com leitura oficial e desabilita ao perder acesso', async (connectorId, provider, publicConfig, url, body) => {
    const accessToken = 'token-fixture-google';
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(body))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect((await call('connector.configure', { connectorId, provider, publicConfig, secrets: { accessToken } })).ok).toBe(true);
      expect((await call('connector.setEnabled', { connectorId, enabled: true })).ok).toBe(false);
      expect((await call('connector.test', { connectorId })).result).toMatchObject({ ok: true, status: 'CONECTADO' });
      expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${accessToken}` }), redirect: 'error' }));
      expect((await call('connector.setEnabled', { connectorId, enabled: true })).ok).toBe(true);
      expect((await call('connector.test', { connectorId })).result).toMatchObject({ ok: false, status: 'HTTP_401' });
      expect(db.row('SELECT enabled FROM connector_states WHERE connector_id=?', connectorId)).toMatchObject({ enabled: 0 });
      expect(JSON.stringify((await call('connector.registry')).result)).not.toContain(accessToken);
      expect((await call('connector.disconnect', { connectorId })).ok).toBe(true);
      expect(db.row('SELECT connector_id FROM connector_runtime_config WHERE connector_id=?', connectorId)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('inclui snapshots agregados e por anúncio no relatório de KPIs sem misturar as entidades', async () => {
    seedImportAccount('acct-report-kpi');
    const at = new Date().toISOString();
    const ingest = await call('capture.ingest', {
      marketplace:'mercado_livre', accountId:'acct-report-kpi', pageKind:'seller_ads',
      url:'https://www.mercadolivre.com.br/anuncios/publicidade', sourceClass:'A_PRIMARY_UI',
      referenceAt:at, collectedAt:at, method:'content_script_dom', listings:[], accountMetrics:{adSpend:12.5},
      evidence:{adSpend:'Investimento em publicidade',filtersAndPeriod:'["Período=Últimos 7 dias"]'},
    });
    expect(ingest.ok).toBe(true);
    const listingIngest = await call('capture.ingest', {
      marketplace:'mercado_livre', accountId:'acct-report-kpi', pageKind:'product_detail',
      url:'https://www.mercadolivre.com.br/anuncio/ML-REPORT-1', sourceClass:'A_PRIMARY_UI',
      referenceAt:at, collectedAt:new Date(Date.parse(at)+1000).toISOString(), method:'content_script_dom',
      listings:[{listingId:'ML-REPORT-1',title:'Produto relatório',gmv:100,netRevenue:90}],
      evidence:{gmv:'Faturamento bruto',netRevenue:'Receita líquida',filtersAndPeriod:'["Período=Últimos 7 dias"]'},
    });
    expect(listingIngest.ok).toBe(true);
    const report = await call('report.export',{type:'KPIS',format:'json',accountId:'acct-report-kpi'});
    expect(report.ok).toBe(true);
    const rows = (report.result as {rows:Array<Record<string,unknown>>}).rows;
    expect(rows).toHaveLength(2);
    const accountRow = rows.find((row) => row.entityType === 'account')!;
    const listingRow = rows.find((row) => row.entityType === 'listing')!;
    expect((accountRow.metrics as Record<string,unknown>).adSpend).toBe(12.5);
    expect((accountRow.evidence as Record<string,unknown>).adSpend).toBe('Investimento em publicidade');
    expect((listingRow.metrics as Record<string,unknown>).netRevenue).toBe(90);
    expect((listingRow.evidence as Record<string,unknown>).netRevenue).toBe('Receita líquida');
    expect((listingRow.evidence as Record<string,unknown>).filtersAndPeriod).toBe('["Período=Últimos 7 dias"]');
  });

  it('não deixa ativar conector que exige credenciais sem conexão verificada', async () => {
    db.db.prepare(`INSERT INTO connector_registry (id,label,category,status,requires_credentials) VALUES (?,?,?,?,?)`)
      .run('connector-test-oauth','Conector OAuth de teste','analytics','NAO_CONECTADO',1);
    const result = await call('connector.setEnabled',{connectorId:'connector-test-oauth',enabled:true});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('credenciais e teste de conexão');
    const state = db.row<{enabled:number}>('SELECT enabled FROM connector_states WHERE connector_id=?','connector-test-oauth');
    expect(state).toBeNull();
  });

  it('desconecta o conector, remove somente seus segredos e registra a operação', async () => {
    db.db.prepare(`INSERT INTO connector_registry (id,label,category,status,requires_credentials) VALUES (?,?,?,?,?)`)
      .run('connector-disconnect-test','Conector conectado','analytics','CONECTADO',1);
    db.db.prepare(`INSERT INTO connector_states (connector_id,enabled,updated_at,updated_by) VALUES (?,?,?,?)`)
      .run('connector-disconnect-test',1,new Date().toISOString(),'admin');
    db.db.prepare(`INSERT INTO connector_credentials_metadata (id,connector_id,label,masked_hint,stored_in,created_at) VALUES (?,?,?,?,?,?)`)
      .run('credential-meta-1','connector-disconnect-test','Token OAuth','abcd…yz','secrets',new Date().toISOString());
    const store = new SecretStore(db, join(dir, 'secrets'));
    store.set('connector:connector-disconnect-test:access_token','token-que-nao-pode-vazar');
    store.set('connector:connector-disconnect-test:refresh_token','refresh-que-nao-pode-vazar');
    store.set('connector:outro:access_token','token-de-outro-conector');

    const response = await call('connector.disconnect',{connectorId:'connector-disconnect-test'});
    expect(response.ok).toBe(true);
    const result = response.result as {status:string;enabled:boolean;secretsRemoved:number;credentialMetadataRemoved:number};
    expect(result.status).toBe('NAO_CONECTADO');
    expect(result.enabled).toBe(false);
    expect(result.secretsRemoved).toBe(2);
    expect(result.credentialMetadataRemoved).toBe(1);
    expect(store.get('connector:connector-disconnect-test:access_token')).toBeNull();
    expect(store.get('connector:connector-disconnect-test:refresh_token')).toBeNull();
    expect(store.get('connector:outro:access_token')).toBe('token-de-outro-conector');
    expect(db.row<{status:string}>('SELECT status FROM connector_registry WHERE id=?','connector-disconnect-test')?.status).toBe('NAO_CONECTADO');
    expect(db.row<{enabled:number}>('SELECT enabled FROM connector_states WHERE connector_id=?','connector-disconnect-test')?.enabled).toBe(0);
    expect(db.row<{count:number}>('SELECT COUNT(*) AS count FROM connector_credentials_metadata WHERE connector_id=?','connector-disconnect-test')?.count).toBe(0);
    const audit = db.row<{reason:string}>('SELECT reason FROM audit_log WHERE entity=? AND entity_id=? ORDER BY id DESC LIMIT 1','connector','connector-disconnect-test');
    expect(audit?.reason).not.toContain('token-que-nao-pode-vazar');
  });
});


describe('workspace com evidências',()=>{
  it('exige confirmação, registra indisponibilidade e isola histórico e memória',async()=>{
    seedImportAccount('workspace-a');seedImportAccount('workspace-b');
    const denied=await call('agent.workspace.ask',{accountId:'workspace-a',topic:'Avaliar loja',confirmedExternal:false});expect(denied.ok).toBe(false);
    const missing=await call('agent.workspace.ask',{accountId:'workspace-a',topic:'Avaliar loja',confirmedExternal:true});
    expect(missing.result).toMatchObject({ok:false,error:'NO_KEY',context:{snapshots:[],seo:[]}});
    const history=await call('agent.workspace.history',{accountId:'workspace-a'});expect(history.result).toHaveLength(1);
    expect((await call('agent.workspace.history',{accountId:'workspace-b'})).result).toEqual([]);
    const knowledge=new KnowledgeBase(db);knowledge.add({scope:'operacao',title:'Teste',content:'Privado',source:'HUMAN',confidence:1,accountId:'workspace-a'});
    expect((await call('agent.memory',{accountId:'workspace-a'})).result).toHaveLength(1);
    expect((await call('agent.memory',{accountId:'workspace-b'})).result).toEqual([]);
    expect((await call('agent.budget',{accountId:'workspace-a'})).result).toMatchObject({callsToday:0,tokensIn:0,tokensOut:0,costUsd:0,windowHours:24});
  });
});

describe('Etapa 07 — evidência externa, confiança e automação',()=>{
  const context=():AgentContext=>({accountId:'agent-a',listingId:'agent-listing',marketplace:'mercado_livre',window:{start:'2026-11-01T00:00:00.000Z',end:'2026-11-26T23:59:59.999Z',days:26},metrics:{adSpendCents:1000},missingData:[],dataConfidence:0.9});
  it('não classifica Ads deficitários com receita desconhecida e não inventa impacto',()=>{
    const ctx=context();
    expect(runAgents(['ads'],ctx)).toEqual([]);
    ctx.metrics.adRevenueCents=0;ctx.metrics.contributionMarginPct=-5;
    const recs=runAgents(['ads','ads'],ctx);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.impactRange).toBeNull();
    expect(synthesize(recs,ctx).finalAction?.agentKey).toBe('ads');
    ctx.dataConfidence=0.3;
    expect(synthesize(recs,ctx).finalAction).toBeNull();
  });
  it('usa sinais externos com origem, data, escopo, zero legítimo e termos relacionados',()=>{
    const now=new Date().toISOString();
    const rows=[{id:'seo1',mode:'suggestions',scope:'GOOGLE_BR_PT',captured_at:now,result_json:JSON.stringify([{keyword:'capacete fechado',searchVolume:0,keywordDifficulty:10},{keyword:'vestido longo',searchVolume:200},{keyword:'capacete fechado',searchVolume:300}])}];
    const evidence=matchedSeoEvidence(rows,'Capacete fechado preto');
    expect(evidence).toEqual([{id:'seo1',mode:'suggestions',scope:'GOOGLE_BR_PT',keyword:'capacete fechado',volume:0,difficulty:10,capturedAt:now}]);
    const ctx={...context(),externalSeo:evidence};
    const recs=runAgents(['seo_demand','keyword_rank'],ctx);
    expect(recs).toHaveLength(2);
    expect(recs[0]?.evidence[0]).toMatchObject({sourceClass:'D_PUBLIC_OBSERVATION',referenceAt:now});
    expect(recs[0]?.evidence[0]?.value).toContain('seo1');
    expect(synthesize(recs,ctx).finalAction).toBeNull();
  });
  it('reconhece evidência SEO somente na loja vinculada e sem nova consulta externa',async()=>{
    const accountId='agent-seo-a',other='agent-seo-b',at=new Date().toISOString();
    seedImportAccount(accountId);seedImportAccount(other);
    db.db.prepare('INSERT INTO listings(id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('agent-seo-listing',accountId,'mercado_livre','MLB123456789','Capacete fechado preto','ACTIVE',at,at);
    const insert=db.db.prepare("INSERT INTO seo_external_runs(id,account_id,mode,query,device,scope,requested_at,captured_at,status,result_json) VALUES(?,?,'suggestions','capacete','desktop','GOOGLE_BR_PT',?,?,'OK',?)");
    insert.run('agent-seo-own',accountId,at,at,JSON.stringify([{keyword:'capacete fechado',searchVolume:0}]));
    insert.run('agent-seo-other',other,at,at,JSON.stringify([{keyword:'capacete fechado',searchVolume:9000}]));
    const result=await call('analysis.run',{accountId,listingId:'agent-seo-listing',mode:'360',agents:['seo_demand']});
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({analyses:[{contextEvidence:{externalSeo:[{id:'agent-seo-own',volume:0}]},recommendations:[{agentKey:'seo_demand',impactRange:null}]}]});
    expect(JSON.stringify(result.result)).not.toContain('agent-seo-other');
  });
  it('não permite aplicar patch pelo IPC ou declarar rollback sem restaurar arquivos',async()=>{
    const proposalId='11111111-1111-4111-8111-111111111111';
    expect((await call('autoupgrade.apply',{proposalId,approved:true})).result).toMatchObject({applied:false});
    expect((await call('autoupgrade.rollback',{proposalId})).result).toMatchObject({ok:false});
  });
  it('corrige o deslocamento de hunks e rejeita instruções proibidas em linhas posteriores',()=>{
    const diff='diff --git a/safe.ts b/safe.ts\n--- a/safe.ts\n+++ b/safe.ts\n@@ -1 +1,2 @@\n-a\n+x\n+y\n@@ -3 +4 @@\n-c\n+z\n';
    let written='';
    expect(applyUnifiedDiff(diff,()=> 'a\nb\nc',(_,content)=>{written=content})).toEqual({appliedFiles:['safe.ts'],errors:[]});
    expect(written).toBe('x\ny\nb\nz');
    expect(validatePatchSyntax(diff.replace('+z','+skipAuth()'))).toBe(false);
  });
  it('serializa chamadas Gemini e evita nova chamada depois de rate limit',async()=>{
    let release!:()=>void,calls=0;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const c=new GeminiClient(db,new SecretStore(db,join(dir,'sec-rate')),async()=>{calls++;await gate;return {ok:false,status:429,json:{}};});
    c.setKey('AIzaSyTesteChaveComTamanhoSuficiente123');
    const input={agentKey:'test',model:'gemini-2.5-flash' as const,systemPrompt:'s',userContent:'u'};
    const first=c.call(input);
    expect(await c.call(input)).toMatchObject({ok:false,errorCode:'RATE_LIMIT'});
    release();expect(await first).toMatchObject({ok:false,errorCode:'RATE_LIMIT',pauseExternal:true});
    expect(await c.call(input)).toMatchObject({ok:false,errorCode:'RATE_LIMIT',pauseExternal:true});
    expect(calls).toBe(1);
  });
  it('percorre páginas de uma análise agendada sem repetir execução',async()=>{
    const accountId='agent-schedule-pages',at=new Date().toISOString();seedImportAccount(accountId);
    const insert=db.db.prepare('INSERT INTO listings(id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
    for(let i=0;i<26;i++)insert.run('page-listing-'+i,accountId,'mercado_livre','PAGE'+i,'Produto '+i,'ACTIVE',at,at);
    const res=await call('analysis.schedule.create',{accountId,mode:'RAPIDA',days:7,cadence:'daily'});
    expect(res.ok).toBe(true);const id=(res.result as {id:string}).id;
    db.db.prepare("UPDATE analysis_schedules SET next_run_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
    expect((await service.processScheduledWork()).analyses).toBe(1);
    const row=db.row<{result_json:string}>('SELECT result_json FROM analysis_schedule_runs WHERE schedule_id=?',id)!;
    expect(JSON.parse(row.result_json)).toMatchObject({listingCount:26,totalMatched:26,pages:2});
    expect(db.row('SELECT COUNT(*) n FROM agent_runs WHERE account_id=?',accountId)).toMatchObject({n:104});
    expect((await service.processScheduledWork()).analyses).toBe(0);
  });
});

describe('Etapa 08 — conectores oficiais',()=>{
  it('vincula GA4, renova token uma vez, preserva zero e isola o histórico',async()=>{
    const accountId='connector-ga4-a',other='connector-ga4-b';seedImportAccount(accountId);seedImportAccount(other);
    const mock=vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({name:'properties/12345/metadata'}))
      .mockResolvedValueOnce(new Response(null,{status:401}))
      .mockResolvedValueOnce(Response.json({access_token:'new-token',refresh_token:'new-refresh'}))
      .mockResolvedValueOnce(Response.json({rowCount:1,metadata:{currencyCode:'BRL'},rows:[{dimensionValues:[{value:'20251101'}],metricValues:[{value:'0'},{value:'0'},{value:'0'},{value:'0'}]}]}));
    vi.stubGlobal('fetch',mock);
    const connectorId='google_analytics4';
    try{
      expect((await call('connector.configure',{connectorId,provider:'GOOGLE_ANALYTICS4',publicConfig:{accountId,propertyId:'12345'},secrets:{accessToken:'old-token',refreshToken:'old-refresh',clientId:'client-id',clientSecret:'client-secret'}})).ok).toBe(true);
      expect((await call('connector.test',{connectorId})).result).toMatchObject({ok:true});
      expect((await call('connector.setEnabled',{connectorId,enabled:true})).ok).toBe(true);
      const input={connectorId,accountId,from:'2025-11-01',to:'2025-11-02',confirmedExternal:true};
      expect((await call('connector.sync',{...input,accountId:other})).ok).toBe(false);
      expect((await call('connector.sync',{...input,confirmedExternal:false})).ok).toBe(false);
      const sync=await call('connector.sync',input);
      expect(sync.result).toMatchObject({ok:true,rowCount:1,requests:3,partial:false});
      const runId=(sync.result as {runId:string}).runId;
      expect((await call('connector.sync.get',{accountId,runId})).result).toMatchObject({rows:[{date:'2025-11-01',values:{sessions:0,purchaseRevenue:0,currency:'BRL'}}]});
      expect((await call('connector.sync.get',{accountId:other,runId})).ok).toBe(false);
      expect((await call('connector.sync.history',{accountId:other})).result).toEqual([]);
      expect(mock.mock.calls[2]?.[0]).toBe('https://oauth2.googleapis.com/token');
      expect(mock.mock.calls[3]?.[1]).toMatchObject({headers:{authorization:'Bearer new-token'}});
      expect(JSON.stringify((await call('connector.registry')).result)).not.toContain('new-token');
      expect((await call('connector.disconnect',{connectorId})).ok).toBe(true);
      expect((await call('connector.sync',input)).ok).toBe(false);
    }finally{vi.unstubAllGlobals();}
  });
});

describe('Etapa 08 — regressões de conectores e importações',()=>{
  it('pagina Mercado Livre somente no mesmo escopo, sem replay e sem promover dados comerciais',async()=>{
    const accountId='ml-api-a',other='ml-api-b',connectorId='mercado_livre_official_api';seedImportAccount(accountId);seedImportAccount(other);
    const mock=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({id:123,site_id:'MLB'}))
      .mockResolvedValueOnce(Response.json({id:123,site_id:'MLB'}))
      .mockResolvedValueOnce(Response.json({results:Array.from({length:50},(_,i)=>'MLB'+(1000+i)),paging:{total:51}}))
      .mockResolvedValueOnce(Response.json({id:123,site_id:'MLB'}))
      .mockResolvedValueOnce(Response.json({results:['MLB1050'],paging:{total:51}}));
    vi.stubGlobal('fetch',mock);
    try{
      expect((await call('connector.configure',{connectorId,provider:'MARKETPLACE_SERVICE',publicConfig:{accountId,sellerId:'123'},secrets:{accessToken:'fixture'}})).ok).toBe(true);
      expect((await call('connector.test',{connectorId})).result).toMatchObject({ok:true});
      expect((await call('connector.setEnabled',{connectorId,enabled:true})).ok).toBe(true);
      const input={connectorId,accountId,confirmedExternal:true};
      const first=await call('connector.sync',input);expect(first.result).toMatchObject({ok:true,rowCount:50,partial:true});
      const runId=(first.result as {runId:string}).runId;
      expect((await call('connector.sync.history',{accountId})).result).toMatchObject([{id:runId,has_next:1}]);
      expect((await call('connector.sync',{...input,accountId:other,continueRunId:runId})).ok).toBe(false);
      const second=await call('connector.sync',{...input,continueRunId:runId});expect(second.result).toMatchObject({ok:true,rowCount:1,partial:true});
      expect((await call('connector.sync',{...input,continueRunId:runId})).ok).toBe(false);
      expect(mock.mock.calls[4]?.[0]).toContain('offset=50');expect(mock).toHaveBeenCalledTimes(5);
      expect(db.row('SELECT COUNT(*) n FROM listings WHERE account_id=?',accountId)).toMatchObject({n:0});
      expect(JSON.stringify((await call('connector.sync.history',{accountId})).result)).not.toContain('next_cursor');
    }finally{vi.unstubAllGlobals();}
  });
  it('bloqueia antes da rede ao atingir quota persistida e preserva histórico',async()=>{
    const accountId='quota-api',connectorId='google_search_console';seedImportAccount(accountId);
    const mock=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({siteUrl:'sc-domain:example.com'}));vi.stubGlobal('fetch',mock);
    try{
      expect((await call('connector.configure',{connectorId,provider:'GOOGLE_SEARCH_CONSOLE',publicConfig:{accountId,siteUrl:'sc-domain:example.com'},secrets:{accessToken:'fixture'}})).ok).toBe(true);
      expect((await call('connector.test',{connectorId})).result).toMatchObject({ok:true});
      expect((await call('connector.setEnabled',{connectorId,enabled:true})).ok).toBe(true);
      const insert=db.db.prepare('INSERT INTO connector_request_log(id,connector_id,requested_at,operation) VALUES(?,?,?,?)');
      for(let i=0;i<29;i++)insert.run('quota-'+i,connectorId,new Date().toISOString(),'SYNC');
      const result=await call('connector.sync',{connectorId,accountId,confirmedExternal:true});
      expect(result.result).toMatchObject({ok:false,status:'LIMITE_LOCAL',requests:0});expect(mock).toHaveBeenCalledTimes(1);
      expect((await call('connector.sync.history',{accountId})).result).toMatchObject([{status:'LIMITE_LOCAL'}]);
    }finally{vi.unstubAllGlobals();}
  });
  it('registra Trends e exportações autorizadas sem duplicação, zero falso ou acesso entre lojas',async()=>{
    const accountId='export-a',other='export-b';seedImportAccount(accountId);seedImportAccount(other);
    const csvText='Categoria: Todas as categorias\n\nSemana,capacete: (Brasil)\n2025-11-01,0\n2025-11-08,<1\n2025-11-15,100';
    const input={accountId,csvText,confirmedSource:true};
    const a=await call('connector.trends.import',input);expect(a.result).toMatchObject({ok:true,rowCount:3,duplicate:false});
    const id=(a.result as {runId:string}).runId;
    expect((await call('connector.trends.import',input)).result).toMatchObject({runId:id,duplicate:true});
    expect((await call('connector.sync.get',{accountId,runId:id})).result).toMatchObject({rows:[{values:{index:0}},{values:{index:null,qualifier:'LT_1'}},{values:{index:100}}]});
    expect((await call('connector.sync.get',{accountId:other,runId:id})).ok).toBe(false);
    const ext={accountId,connectorId:'seo_service_generic',providerLabel:'Fornecedor autorizado',datasetLabel:'Pesquisa',fileName:'dados.csv',fileType:'csv',csvText:'term;volume\ncapacete;0\nluva;123',referenceDate:'2025-11-01',confirmedSource:true};
    const b=await call('connector.external.import',ext);expect(b.result).toMatchObject({ok:true,rowCount:2,duplicate:false});
    const runId=(b.result as {runId:string}).runId;
    expect((await call('connector.external.import',ext)).result).toMatchObject({runId,duplicate:true});
    const detail=await call('connector.sync.get',{accountId,runId,limit:1});
    expect(detail.result).toMatchObject({total:2,nextOffset:1,rows:[{values:{term:'capacete',volume:'0'}}]});
    expect((await call('connector.sync.get',{accountId,runId,limit:1,offset:1})).result).toMatchObject({nextOffset:null,rows:[{values:{term:'luva',volume:'123'}}]});
    expect((await call('connector.external.import',{...ext,confirmedSource:false})).ok).toBe(false);
    expect((await call('connector.sync.get',{accountId:other,runId})).ok).toBe(false);
    expect(db.row('SELECT COUNT(*) n FROM listing_snapshots WHERE account_id=?',accountId)).toMatchObject({n:0});
  });
});

describe('Etapa 09 — relatórios e administração',()=>{
  it('gera relatório por anúncio isolado e PDF real, paginado com metadados',async()=>{
    const accountId='report-stage9-a',other='report-stage9-b';seedImportAccount(accountId);seedImportAccount(other);
    const at=new Date().toISOString();
    const insert=db.db.prepare('INSERT INTO listings(id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
    insert.run('report-a-1',accountId,'mercado_livre','MLB123','Capacete São Paulo','ACTIVE',at,at);
    insert.run('report-a-2',accountId,'mercado_livre','MLB124','Luva','ACTIVE',at,at);
    insert.run('report-b-1',other,'mercado_livre','MLB999','Outra loja','ACTIVE',at,at);
    const first=await call('report.export',{type:'ANUNCIO',format:'pdf',accountId,limit:1});
    expect(first.ok).toBe(true);
    const result=first.result as {pdfBase64:string;rows:Array<Record<string,unknown>>;nextOffset:number};
    expect(result.rows).toMatchObject([{id:'report-a-1',kpis:null}]);expect(result.nextOffset).toBe(1);
    const pdf=Buffer.from(result.pdfBase64,'base64').toString('ascii');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);expect(pdf).toContain('xref');expect(pdf).toContain('MLB123');expect(pdf).not.toContain('MLB999');
    expect(pdf).toContain('Escopo');
    expect((await call('report.export',{type:'ANUNCIO',format:'json',accountId,limit:1,offset:1})).result).toMatchObject({rows:[{id:'report-a-2'}],nextOffset:null});
    expect((await call('report.export',{type:'ANUNCIO',accountId,listingId:'report-b-1'})).ok).toBe(false);
    expect((await call('report.export',{type:'ANUNCIO',accountId,marketplace:'amazon'})).ok).toBe(false);
  });
  it('exporta lucro realizado distinto de cadastro de custo, sem somar lojas',async()=>{
    const accountId='finance-report-a',other='finance-report-b';seedImportAccount(accountId);seedImportAccount(other);
    const input={accountId,periodStart:'2025-01-01T00:00:00.000Z',periodEnd:'2025-01-31T23:59:59.000Z',netRevenueCents:10000,productCostCents:2000,packagingCents:100,shippingCents:100,marketplaceFeesCents:1000,taxesCents:500,adSpendCents:300,refundsCents:0,returnLogisticsCents:0,cancellationLossCents:0,otherCostsCents:0,sourceClass:'F_USER_INPUT',evidence:{source:'fixture'}};
    expect((await call('finance.realized.upsert',input)).ok).toBe(true);
    expect((await call('finance.realized.upsert',{...input,accountId:other})).ok).toBe(true);
    const report=await call('report.export',{type:'FINANCEIRO',format:'json',accountId});
    expect(report.ok).toBe(true);
    expect(report.result).toMatchObject({summary:{records:1,realizedProfitCents:6000},rows:[{recordType:'RESULTADO_REALIZADO',account_id:accountId,net_revenue_cents:10000,realizedProfitCents:6000}]});
  });
  it('restringe auditoria global e agendamentos a seu responsável ou admin',async()=>{
    const schedule=await call('report.schedule.create',{reportType:'AUDITORIA',format:'json',cadence:'daily'});
    expect(schedule.ok).toBe(true);const id=(schedule.result as {id:string}).id;
    const created=await call('user.upsert',{email:'stage9viewer@local.test',displayName:'Viewer',role:'visualizador',password:'senha-stage9-viewer'});
    expect(created.ok).toBe(true);
    const login=await call('auth.login',{email:'stage9viewer@local.test',password:'senha-stage9-viewer'},false);
    const userToken=(login.result as {token:string}).token;
    const viewer=(method:string,payload:unknown)=>service.handle({id:'viewer',protocolVersion:1,method,payload,token:userToken});
    expect((await viewer('report.export',{type:'AUDITORIA'})).ok).toBe(false);
    expect((await viewer('report.schedule.create',{reportType:'AUDITORIA',cadence:'daily'})).ok).toBe(false);
    expect((await viewer('report.schedule.list',{})).result).toEqual([]);
    expect((await viewer('report.schedule.setEnabled',{id,enabled:false})).ok).toBe(false);
    db.db.prepare("UPDATE report_schedules SET next_run_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
    expect((await service.processScheduledWork()).reports).toBe(1);
    const runs=(await call('report.schedule.runs',{scheduleId:id})).result as Array<{id:string}>;
    expect(runs).toHaveLength(1);
    expect((await viewer('report.schedule.run.get',{runId:runs[0]!.id})).ok).toBe(false);
    expect((await viewer('report.schedule.runs',{scheduleId:id})).result).toEqual([]);
    expect((await call('report.schedule.run.get',{runId:runs[0]!.id})).ok).toBe(true);
  });
  it('restaura última revisão financeira por conta, sem alterar outra loja',async()=>{
    const accountId='limit-stage9-a',other='limit-stage9-b';seedImportAccount(accountId);seedImportAccount(other);
    const limits={maxCampaignDailyBudgetCents:1000,minVariationPriceCents:100,maxVariationPriceCents:5000,maxVariationStock:5,maxVariationPriceChangePct:10};
    expect((await call('operation.limits.set',{accountId,limits,confirmed:true})).ok).toBe(true);
    expect((await call('operation.limits.set',{accountId,limits:{...limits,maxCampaignDailyBudgetCents:1200},confirmed:true})).ok).toBe(true);
    const history=(await call('operation.limits.history',{accountId})).result as Array<{id:string}>;
    expect(history).toHaveLength(2);
    expect((await call('operation.limits.restore',{accountId,revisionId:history[1]!.id,confirmed:true})).ok).toBe(false);
    expect((await call('operation.limits.restore',{accountId:other,revisionId:history[0]!.id,confirmed:true})).ok).toBe(false);
    expect((await call('operation.limits.restore',{accountId,revisionId:history[0]!.id,confirmed:true})).result).toMatchObject({limits});
    expect((await call('operation.limits.restore',{accountId,revisionId:history[0]!.id,confirmed:true})).ok).toBe(false);
    expect((await call('operation.limits.get',{accountId:other})).result).toMatchObject({limits:null});
    expect((await call('operation.limits.history',{accountId})).result).toHaveLength(3);
  });
  it('remove chave Gemini local somente mediante confirmação',async()=>{
    expect((await call('gemini.setKey',{apiKey:'fixture-api-key-stage9-123456'})).ok).toBe(true);
    expect((await call('gemini.clearKey',{confirmed:false})).ok).toBe(false);
    expect((await call('agent.budget')).result).toMatchObject({geminiConfigured:true});
    expect((await call('gemini.clearKey',{confirmed:true})).ok).toBe(true);
    expect((await call('agent.budget')).result).toMatchObject({geminiConfigured:false});
  });
});

describe('Relatórios agendados paginados',()=>{
  it('armazena todas as partes e aplica a permissão por execução',async()=>{
    const accountId='schedule-paged';seedImportAccount(accountId);
    const at=new Date().toISOString(),stmt=db.db.prepare('INSERT INTO listings(id,account_id,marketplace,external_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
    for(let i=0;i<501;i++)stmt.run('paged-'+String(i).padStart(4,'0'),accountId,'mercado_livre','MLB'+(1000+i),'Anúncio '+i,'ACTIVE',at,at);
    const created=await call('report.schedule.create',{accountId,reportType:'ANUNCIO',format:'json',cadence:'daily'});expect(created.ok).toBe(true);
    const id=(created.result as {id:string}).id;
    db.db.prepare("UPDATE report_schedules SET next_run_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
    expect((await service.processScheduledWork()).reports).toBe(1);
    const runs=(await call('report.schedule.runs',{scheduleId:id})).result as Array<{id:string;row_count:number}>;
    expect(runs[0]?.row_count).toBe(501);
    const runId=runs[0]!.id;
    const first=(await call('report.schedule.run.get',{runId,page:0})).result as {reportJson:string;pageCount:number;partial:boolean};
    expect(first.pageCount).toBe(2);expect(first.partial).toBe(false);expect(JSON.parse(first.reportJson).rowCount).toBe(500);
    const last=(await call('report.schedule.run.get',{runId,page:1})).result as {reportJson:string};
    expect(JSON.parse(last.reportJson).rows).toMatchObject([{id:'paged-0500'}]);
    expect((await call('report.schedule.run.get',{runId,page:2})).ok).toBe(false);
  });
});

describe('Migração 052 — preservação do histórico',()=>{
  it('preserva agendamentos, execuções e páginas de uma base anterior',()=>{
    const migrationDir=join(dir,'legacy-migrations');mkdirSync(migrationDir);
    const originalDir=new URL('../migrations/',import.meta.url);
    const names=readdirSync(originalDir).filter(name=>/^\d+_.*\.sql$/.test(name));
    for(const name of names.filter(name=>Number(name.split('_')[0])<=51))copyFileSync(new URL(name,originalDir),join(migrationDir,name));
    const legacy=new LocalDatabase({file:join(dir,'legacy.db'),migrationsDir:migrationDir});
    try{
      legacy.migrate();const at=new Date().toISOString();
      legacy.db.prepare("INSERT INTO report_schedules(id,report_type,format,cadence,enabled,next_run_at,created_at,updated_at,interval_minutes,consecutive_failures) VALUES(?,?,?,?,?,?,?,?,?,?)").run('legacy-schedule','KPIS','json','1h',1,at,at,at,45,2);
      legacy.db.prepare("INSERT INTO report_schedule_runs(id,schedule_id,generated_at,status,report_json,row_count) VALUES(?,?,?,?,?,?)").run('legacy-run','legacy-schedule',at,'COMPLETED','{}',1);
      legacy.db.prepare("INSERT INTO report_schedule_pages(run_id,page_index,report_json) VALUES(?,?,?)").run('legacy-run',0,'{"rows":[{"id":"legacy-row"}]}');
      for(const name of names.filter(name=>Number(name.split('_')[0])===52))copyFileSync(new URL(name,originalDir),join(migrationDir,name));
      expect(legacy.migrate().applied).toEqual([52]);
      expect(legacy.row('SELECT report_type,interval_minutes,consecutive_failures FROM report_schedules WHERE id=?','legacy-schedule')).toMatchObject({report_type:'KPIS',interval_minutes:45,consecutive_failures:2});
      expect(legacy.row('SELECT row_count FROM report_schedule_runs WHERE id=?','legacy-run')).toMatchObject({row_count:1});
      expect(legacy.row('SELECT report_json FROM report_schedule_pages WHERE run_id=?','legacy-run')).toMatchObject({report_json:'{"rows":[{"id":"legacy-row"}]}'});
      legacy.db.prepare('UPDATE report_schedules SET report_type=? WHERE id=?').run('ANUNCIO','legacy-schedule');
      expect(legacy.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(legacy.migrate().applied).toEqual([]);
    }finally{legacy.close();}
  });
});

describe('Alertas da etapa 10',()=>{
  it('isola escopo e globais; reconhece uma única vez e não aceita alerta inexistente ou classificação divergente',async()=>{
    seedImportAccount('alert-a');seedImportAccount('alert-b');
    const stmt=db.db.prepare("INSERT INTO alerts(id,account_id,kind,severity,title,rule,created_at) VALUES(?,?,?,'WARN',?,?,?)");
    const at=new Date().toISOString();
    stmt.run('alert-a1','alert-a','TEST','Alerta A','TEST',at);
    stmt.run('alert-b1','alert-b','TEST','Alerta B','TEST',at);
    stmt.run('alert-global',null,'TEST','Global','TEST',at);
    expect((await call('alerts.list',{accountId:'alert-a'})).result).toMatchObject([{id:'alert-a1'}]);
    const withGlobal=(await call('alerts.list',{accountId:'alert-a',includeGlobal:true})).result as {id:string}[];
    expect(withGlobal.map(x=>x.id).sort()).toEqual(['alert-a1','alert-global']);
    expect((await call('competitor.alerts',{accountId:'alert-a'})).result).toMatchObject([{id:'alert-a1'}]);
    expect((await call('alerts.ack',{alertId:'absent',accountId:'alert-a'})).ok).toBe(false);
    expect((await call('alerts.ack',{alertId:'alert-b1',accountId:'alert-a'})).ok).toBe(false);
    const first=await call('alerts.ack',{alertId:'alert-a1',accountId:'alert-a',falsePositive:true});
    expect(first.result).toMatchObject({ok:true,alreadyAcknowledged:false});
    expect((await call('alerts.ack',{alertId:'alert-a1',accountId:'alert-a',falsePositive:true})).result).toMatchObject({ok:true,alreadyAcknowledged:true});
    expect((await call('alerts.ack',{alertId:'alert-a1',accountId:'alert-a',falsePositive:false})).ok).toBe(false);
    expect((await call('alerts.list',{accountId:'alert-a',includeAcknowledged:false})).result).toEqual([]);
    expect(db.row("SELECT COUNT(*) n FROM audit_log WHERE action='ALERT_ACK' AND entity_id='alert-a1'")).toMatchObject({n:1});
    expect(db.row("SELECT acknowledged_at FROM alerts WHERE id='alert-b1'")).toMatchObject({acknowledged_at:null});
    await call('user.upsert',{email:'alert-operator@local.test',displayName:'Operador',role:'operador',password:'senha-alerta-op-123'});
    const login=await call('auth.login',{email:'alert-operator@local.test',password:'senha-alerta-op-123'},false);
    const operator=(login.result as {token:string}).token;
    const denied=await service.handle({id:'denied',protocolVersion:1,method:'alerts.ack',payload:{alertId:'alert-global',accountId:null},token:operator});
    expect(denied.ok).toBe(false);
    expect(db.row("SELECT acknowledged_at FROM alerts WHERE id='alert-global'")).toMatchObject({acknowledged_at:null});
  });
});
