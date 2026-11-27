/**
 * Utilitários do DOM usados pelos content scripts.
 *
 * Este arquivo é injetado ANTES do content script de cada marketplace e publica
 * `window.MI_DOM`. Ele é declarado no manifest como primeiro arquivo da lista.
 *
 * Regras inegociáveis (§0.2, §13.2):
 *  - Só se lê o que está RENDERIZADO e visível para o usuário logado.
 *  - Nunca se lê cookie, localStorage de sessão, header ou token.
 *  - Nunca se chama endpoint privado: nenhum fetch/XHR aqui.
 *  - Todo número vem com a evidência textual (rótulo → texto lido) para auditoria.
 */
(function () {
  'use strict';

  /** Lê um número pt-BR ("1.234,56", "12,5%", "R$ 1.234"). null se não houver número. */
  function parseNumberPtBr(text) {
    if (text === null || text === undefined) return null;
    const raw = String(text).replace(/\u00a0/g, ' ').trim();
    const match = raw.match(/^(?:R\$\s*)?(-?\d[\d.,]*)(?:\s*(?:%|unidades?|vendidos?|pedidos?|visitas?|cliques?|impressões?))?$/i);
    if (!match) return null;
    const cleaned = match[1];
    if (!cleaned || !/\d/.test(cleaned)) return null;

    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    let normalized = cleaned;

    if (lastComma > -1 && lastDot > -1) {
      if (lastComma > lastDot) normalized = cleaned.replace(/\./g, '').replace(',', '.');
      else normalized = cleaned.replace(/,/g, '');
    } else if (lastComma > -1) {
      const decimals = cleaned.length - lastComma - 1;
      normalized = decimals === 3 ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.');
    } else if (lastDot > -1) {
      const decimals = cleaned.length - lastDot - 1;
      normalized = decimals === 3 ? cleaned.replace(/\./g, '') : cleaned;
    }

    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
  }

  function normalizeLabel(text) {
    return String(text)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/[.:]$/, '');
  }

  /** Procura o valor associado a um rótulo visível. Devolve { text, label, node } ou null. */
  function findValueByLabel(root, labels) {
    if (!root) return null;
    const wanted = labels.map(normalizeLabel);
    // A row may contain only numeric cells. Accept an unambiguous visible header
    // from the same table, never infer a column by position alone.
    if(String(root.tagName??'').toUpperCase()==='TR' && root.cells){
      const table=root.closest?.('table'), rows=table?.tHead?.rows;
      const cells=Array.from(root.cells),headers=rows?.length===1?Array.from(rows[0].cells):[];
      if(headers.length===cells.length&&headers.every(el=>(el.colSpan??1)===1&&(el.rowSpan??1)===1)&&cells.every(el=>(el.colSpan??1)===1&&(el.rowSpan??1)===1)){
        const indexes=headers.map((el,index)=>isVisible(el)&&wanted.includes(normalizeLabel(el.innerText??el.textContent??''))?index:-1).filter(i=>i>=0);
        if(indexes.length===1){
          const cell=cells[indexes[0]],text=String(cell.innerText??cell.textContent??'').trim();
          if(isVisible(cell)&&parseNumberPtBr(text)!==null)return {text,label:String(headers[indexes[0]].innerText??headers[indexes[0]].textContent??'').trim(),node:cell};
        }
      }
    }
    const nodes = root.querySelectorAll('div, span, td, th, dt, dd, li, p, label, strong, b');
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const raw = String(node.innerText ?? node.textContent ?? '').trim();
      const text = normalizeLabel(raw);
      if (!text || text.length > 80) continue;
      if (!wanted.some((w) => text === w || text.startsWith(w + ':') || text.startsWith(w + ' - '))) continue;
      const inline = raw.match(/[:\-]\s*(.+)$/);
      if (inline && parseNumberPtBr(inline[1]) !== null) return { text: inline[1].trim(), label: raw, node };
      const sibling = node.nextElementSibling;
      const siblingText = sibling && isVisible(sibling) ? String(sibling.innerText ?? sibling.textContent ?? '').trim() : '';
      if (siblingText && parseNumberPtBr(siblingText) !== null) return { text: siblingText, label: raw, node };
      const parent = node.parentElement;
      if (parent && isVisible(parent)) {
        const rest = String(parent.innerText ?? '').replace(raw, '').replace(/^\s*[:\-]\s*/, '').trim();
        if (rest && parseNumberPtBr(rest) !== null) return { text: rest, label: raw, node };
      }
    }
    return null;
  }

  /** Extrai o ID externo do anúncio a partir da URL (MLB123456, etc.). */
  function extractExternalId(url) {
    const m = String(url).match(/\b(ML[A-Z]?-?\d{5,})\b/i);
    return m ? m[1].toUpperCase() : null;
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    for(let node=el;node;node=node.parentElement){
      const style=window.getComputedStyle(node);
      if(node.hidden||node.getAttribute?.('aria-hidden')==='true'||style.visibility==='hidden'||style.display==='none'||Number(style.opacity||'1')===0)return false;
    }
    return true;
  }

  /** Só aceita links seguintes HTTPS, same-origin e dentro dos hosts suportados. */
  function safeNextPageUrl(rawHref, currentUrl, marketplace) {
    try {
      const current = new URL(currentUrl);
      const next = new URL(rawHref, current);
      const hostAllowed = marketplace === 'mercado_livre'
        ? /(^|\.)mercadolivre\.com\.br$|(^|\.)mercadolibre\.com$/i.test(next.hostname)
        : marketplace === 'shopee'
          ? /(^|\.)shopee\.com\.br$/i.test(next.hostname)
          : marketplace === 'amazon' && next.hostname === 'sellercentral.amazon.com.br';
      if (!hostAllowed || current.protocol !== 'https:' || next.protocol !== 'https:') return null;
      if (next.origin !== current.origin || next.username || next.password) return null;
      if (next.pathname !== current.pathname) return null;
      return next.href;
    } catch {
      return null;
    }
  }

  function paginationInfo(root, currentUrl, marketplace) {
    const candidates = Array.from(root.querySelectorAll('a[rel="next"], a[aria-label], a[title], a[data-testid], a.pagination__next, a.next'));
    const labels = /\b(next|próxima|proxima|seguinte|siguiente|próximo|proximo|next page)\b/i;
    for (const anchor of candidates) {
      const label = normalizeLabel([anchor.getAttribute('aria-label'), anchor.getAttribute('title'), anchor.getAttribute('data-testid'), anchor.textContent].filter(Boolean).join(' '));
      const isNext = anchor.rel === 'next' || labels.test(label) || /pagination[-_ ]?next|next[-_ ]?page/i.test(label);
      if (!isNext || anchor.getAttribute('aria-disabled') === 'true' || anchor.hasAttribute('disabled')) continue;
      const href = safeNextPageUrl(anchor.href || anchor.getAttribute('href') || '', currentUrl, marketplace);
      if (href && isVisible(anchor)) return href;
    }
    return null;
  }

  function hasChallenge(root) {
    if (root.querySelector('iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i], [data-testid*="captcha" i], .g-recaptcha')) return true;
    const text = normalizeLabel(root.body?.innerText || '').slice(0, 12000);
    return /verify you are human|verifique que voce e humano|verifique se voce e humano|confirme que voce nao e um robo|complete o captcha|security check|human verification/.test(text);
  }

  /** Only explicit, visible text fields. Never use a static test-id as an item identity. */
  function visibleCustomerVoice(root, pageKind, marketplace) {
    const spec = {
      seller_questions: ['QUESTION','question-text','question-content','question-description'],
      seller_reputation: ['REVIEW','review-text','review-content','feedback-comment'],
      seller_complaints: ['COMPLAINT','claim-description','complaint-description','dispute-description'],
      seller_returns: ['RETURN_REASON','return-reason','refund-reason','devolution-reason','motivo-devolucao'],
    }[pageKind];
    if (!spec) return [];
    const [kind, ...names] = spec;
    const selectors = names.flatMap(name => ['[data-testid*="' + name + '"]','[class*="' + name + '"]']).join(', ');
    const attrs = { QUESTION:['data-question-id'], REVIEW:['data-review-id','data-feedback-id'], COMPLAINT:['data-claim-id','data-dispute-id'], RETURN_REASON:['data-return-id','data-refund-id'] }[kind];
    const items = [], seen = new Set();
    for (const element of root.querySelectorAll(selectors)) {
      if (items.length >= 50 || !isVisible(element)) continue;
      const text = String(element.innerText ?? '').replace(/\s+/g, ' ').trim();
      if (text.length < 3 || text.length > 5000) continue;
      const row = element.closest([...attrs.map(attr => '[' + attr + ']'),'[data-id]'].join(', '));
      const ref = row && [...attrs,'data-id'].map(attr => row.getAttribute(attr)).find(value => value && /^[A-Za-z0-9_.:-]{1,150}$/.test(value));
      const key = ref ? 'id:' + ref : 'text:' + text;
      if (seen.has(key)) continue;
      seen.add(key);
      // Only identifiers exposed on the feedback row itself. Never match by title or customer text.
      const idAttrs=marketplace==='mercado_livre'?['data-item-id','data-listing-id']:marketplace==='shopee'?['data-product-id','data-item-id']:marketplace==='amazon'?['data-sku','data-asin']:[];
      const ids=[];
      for(const attr of idAttrs){
        const value=row?.getAttribute(attr);
        if(!value)continue;
        if(marketplace==='mercado_livre'&&/^MLB-?\d{5,}$/i.test(value))ids.push(value.toUpperCase());
        if(marketplace==='shopee'&&/^\d+$/.test(value))ids.push(value);
        if(marketplace==='amazon'&&attr==='data-sku'&&/^[A-Za-z0-9_.:-]{1,180}$/.test(value))ids.push('SKU:'+value);
        if(marketplace==='amazon'&&attr==='data-asin'&&!row?.getAttribute('data-sku')&&/^[A-Z0-9]{10}$/.test(value))ids.push(value);
      }
      const unique=[...new Set(ids)];
      items.push({ kind, text, ...(ref ? { externalRef: ref } : {}), ...(unique.length===1?{externalListingId:unique[0]}:{}) });
    }
    return items;
  }

  function paginationUnsupported(root,currentUrl,marketplace) {
    if (paginationInfo(root,currentUrl,marketplace)) return false;
    const selector='button[aria-label],button[title],button[data-testid],button.next,button.pagination__next,[role="button"][aria-label],a[rel="next"],a[aria-label],a[title],a[data-testid],a.next';
    for (const el of root.querySelectorAll(selector)) {
      if (!isVisible(el) || el.disabled || el.getAttribute('aria-disabled')==='true' || el.hasAttribute('disabled')) continue;
      const names=[el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('data-testid'),el.innerText ?? el.textContent].filter(Boolean).map(normalizeLabel);
      if (el.rel==='next' || names.some(name=>/^(next|próxima|proxima|seguinte|siguiente|próximo|proximo)(?:\s+(?:page|página|pagina))?$|pagination[-_ ]?next|next[-_ ]?page/i.test(name))) return true;
    }
    return false;
  }
  function explicitPercent(root, labels) {
    const found=findValueByLabel(root,labels);
    if (!found || !/%\s*$/.test(found.text)) return null;
    const value=parseNumberPtBr(found.text);
    return value!==null && value>=0 && value<=100 ? {value,evidence:String(found.label+': '+found.text).slice(0,200)} : null;
  }
  function observedExtraMetrics(root, listing=false) {
    const metrics={}, evidence={};
    const percentages={conversionRatePct:['taxa de conversão','conversion rate','tasa de conversión'],adConversionRatePct:['taxa de conversão de anúncios','ad conversion rate','taxa de conversão ads']};
    if (listing) percentages.promotionDiscountPct=['desconto promocional','percentual de desconto','promotion discount','discount percentage'];
    for (const [field,labels] of Object.entries(percentages)) {
      const found=explicitPercent(root,labels);
      if(found){metrics[field]=found.value;evidence[field]=found.evidence;}
    }
    const found=findValueByLabel(root,['cliques orgânicos','organic clicks']), clicks=found&&parseNumberPtBr(found.text);
    if(typeof clicks==='number'&&Number.isInteger(clicks)&&clicks>=0){metrics.organicClicks=clicks;evidence.organicClicks=String(found.label+': '+found.text).slice(0,200);}
    if(listing){
      const found=findValueByLabel(root,['preço original','preço anterior','original price','previous price']);
      const value=found&&parseNumberPtBr(found.text);
      if(typeof value==='number'&&value>=0){metrics.originalPrice=value;evidence.originalPrice=String(found.label+': '+found.text).slice(0,200);}
    }
    return {metrics,evidence};
  }
  // Detailed rows require an explicit entity identity; never infer one from position or title.
  function visibleDetailRows(root,pageKind){
    const ads=pageKind==='seller_ads';
    if(!ads&&!['seller_listings','seller_inventory','seller_listing_edit'].includes(pageKind))return [];
    const spec=ads?[['AD','data-ad-id',['data-campaign-id']],['AD_CAMPAIGN','data-campaign-id',[]]]:[['LISTING_VARIANT','data-variation-id',['data-item-id','data-product-id','data-listing-id','data-asin']],['WAREHOUSE_STOCK','data-warehouse-id',['data-variation-id','data-item-id','data-product-id','data-listing-id','data-asin']]];
    const allowedId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(value);
    const out=[],seen=new Set();
    for(const [kind,attr,parents] of spec){
      for(const row of root.querySelectorAll('['+attr+']')){
        if(out.length>=100||!isVisible(row))continue;
        const id=row.getAttribute(attr);
        if(!allowedId(id))continue;
        const parentNode=parents.length?row.closest(parents.map(a=>'['+a+']').join(',')):null;
        const parentId=parentNode&&parents.map(a=>parentNode.getAttribute(a)).find(allowedId);
        if(parents.length&&!parentId)continue;
        // Avoid interpreting a container of multiple ads/variants as one row.
        if(row.querySelector?.('[data-ad-id],[data-variation-id],[data-warehouse-id]'))continue;
        const key=[kind,parentId||'',id].join('|');
        if(seen.has(key))continue;
        const metrics={},evidence={};
        const definitions=ads?{
          adSpend:['investimento em publicidade','gasto com anúncios','ad spend','advertising cost'],
          adClicks:['cliques','clicks','cliques em anúncios','ad clicks'],
          paidImpressions:['impressões','impressions','impressões pagas','ad impressions'],
          adAttributedRevenue:['vendas atribuídas','ad-attributed sales','receita atribuída'],
          adAttributedOrders:['pedidos atribuídos','ad-attributed orders'],
          adConversionRatePct:['taxa de conversão','conversion rate','ad conversion rate'],
        }:{
          price:['preço','price','preço atual'],originalPrice:['preço original','preço anterior','original price'],
          stockAvailable:['estoque','stock','available quantity','disponíveis'],
          promotionDiscountPct:['desconto promocional','percentual de desconto','promotion discount'],
        };
        for(const [field,labels] of Object.entries(definitions)){
          const found=findValueByLabel(row,labels);
          if(!found)continue;
          const percentage=field.endsWith('Pct');
          if(percentage&&!/%\s*$/.test(found.text))continue;
          const value=parseNumberPtBr(found.text);
          if(value===null||value<0||(percentage&&value>100)||(['adClicks','paidImpressions','adAttributedOrders','stockAvailable'].includes(field)&&!Number.isInteger(value)))continue;
          metrics[field]=value;evidence[field]=String(found.label+': '+found.text).slice(0,300);
        }
        if(!Object.keys(metrics).length)continue;
        const labelNode=row.querySelector?.('[data-testid="campaign-name"],[data-testid="ad-name"],[data-testid="variation-name"],[data-testid="warehouse-name"]');
        const label=labelNode&&isVisible(labelNode)?String(labelNode.innerText??'').trim().slice(0,300):'';
        seen.add(key);out.push({kind,externalId:id,...(parentId?{parentExternalId:parentId}:{}),...(label?{label}:{}),metrics,evidence});
      }
    }
    return out;
  }
  // A assinatura usa somente controles explícitos de período e estado, não campos de busca,
  // credenciais, identificadores de cliente ou valores de sessão.
  function collectionFilterState(root){
    const entries=[],warnings=[];
    const selector='input[type="date"],input[type="month"],input[type="week"],select,[role="tab"][aria-selected="true"],button[aria-pressed="true"]';
    for(const el of root.querySelectorAll(selector)){
      if(!isVisible(el)||el.disabled)continue;
      const type=String(el.type??'').toLowerCase();
      const label=normalizeLabel(el.getAttribute('aria-label')||el.getAttribute('name')||el.getAttribute('title')||'');
      const dateType=['date','month','week'].includes(type);
      if(!dateType&&!/^(period|período|periodo|date range|intervalo|status|situação|situacao|start_date|end_date|data inicial|data final|start date|end date|date_from|date_to)$/.test(label))continue;
      const val=String(dateType?el.value??'':el.selectedOptions?.[0]?.innerText??el.selectedOptions?.[0]?.textContent??el.innerText??'').replace(/\s+/g,' ').trim();
      if(!val)continue;
      // Values from recognized controls must be dates, explicit periods or known status names.
      if(!/^(?:\d{4}-(?:\d{2}|W\d{2})(?:-\d{2})?|\d{1,2}\/\d{1,2}\/\d{4}|(?:últimos|ultimos|last) \d{1,3} (?:dias|days)|(?:hoje|ontem|today|yesterday|este mês|this month|mês passado|last month|todos|todas|all|ativo|ativa|active|inativo|inactive|pendente|pending|pago|paid|cancelado|cancelled|enviado|shipped|concluído|completed))$/i.test(val)){
        warnings.push('FILTRO_NAO_RECONHECIDO');continue;
      }
      entries.push((label||type)+'='+val.toLowerCase());
    }
    const signature=[...new Set(entries)].sort().join('|');
    if(signature.length>512){warnings.push('FILTRO_NAO_RECONHECIDO');return {signature:'',warnings:[...new Set(warnings)]};}
    return {signature,warnings:[...new Set(warnings)]};
  }
  function collectionCoverage(root){
    const warnings=[];
    for(const grid of root.querySelectorAll('table[aria-rowcount],[role="grid"][aria-rowcount]')){
      if(!isVisible(grid))continue;
      const total=Number(grid.getAttribute('aria-rowcount'));
      const visible=Array.from(grid.querySelectorAll('tbody tr,[role="row"]')).filter(isVisible).length;
      if(Number.isInteger(total)&&total>visible)warnings.push('TABELA_VIRTUALIZADA');
    }
    if(visibleChartPoints(root).incomplete)warnings.push('GRAFICO_SEM_DADOS_TEXTUAIS');
    return [...new Set(warnings)];
  }
  function visibleMoneyParts(fraction){
    if(!isVisible(fraction))return null;
    const whole=String(fraction.innerText??fraction.textContent??'').trim();
    const container=fraction.closest?.('.andes-money-amount')??fraction;
    const cents=container.querySelector?.('.andes-money-amount__cents');
    if(cents){
      if(!isVisible(cents)||!/^\d{2}$/.test(String(cents.innerText??cents.textContent??'').trim())||!/^(?:\d+|\d{1,3}(?:\.\d{3})+)$/.test(whole))return null;
      const text=whole+','+String(cents.innerText??cents.textContent).trim();
      const value=parseNumberPtBr(text);return value!==null&&value>=0?{value,text}:null;
    }
    const value=parseNumberPtBr(whole);return value!==null&&value>=0?{value,text:whole}:null;
  }
  // Only a single, explicitly identified pagination region and button. No form submits.
  function spaPaginationState(root){
    const regions=Array.from(root.querySelectorAll('nav[aria-label],[role="navigation"][aria-label],[data-testid="pagination"]')).filter(el=>isVisible(el)&&(/^(pagination|paginação|paginacao)$/i.test(String(el.getAttribute('aria-label')||''))||el.getAttribute('data-testid')==='pagination'));
    if(regions.length!==1)return null;
    const region=regions[0],current=Array.from(region.querySelectorAll('[aria-current="page"]')).filter(isVisible);
    if(current.length!==1)return null;
    const raw=String(current[0].innerText??current[0].textContent??'').trim();
    if(!/^\d{1,4}$/.test(raw)||Number(raw)<1)return null;
    const next=Array.from(region.querySelectorAll('button[type="button"]')).filter(el=>isVisible(el)&&!el.closest('form')&&/^(next|next page|próxima|proxima|próxima página|proxima pagina|seguinte)$/i.test(String(el.getAttribute('aria-label')||el.innerText||'').trim()));
    if(next.length!==1)return null;
    return {page:Number(raw),canAdvance:!next[0].disabled&&!next[0].hasAttribute('disabled')&&next[0].getAttribute('aria-disabled')!=='true',button:next[0]};
  }
  function advanceSpaPage(root,expectedPage){
    if(hasChallenge(root)||root.querySelector('input[type="password"], form[action*="login"], form[action*="signin"]'))return false;
    const state=spaPaginationState(root);
    if(!state||!state.canAdvance||state.page!==expectedPage)return false;
    state.button.click();
    return true;
  }
  // Scroll only a recognized grid; verify every declared row index and stable listing ID.
  async function collectVirtualizedListings(root,initial,readSnapshot,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))){
    if(initial.pageKind!=='seller_listings'||!initial.coverageWarnings?.includes('TABELA_VIRTUALIZADA'))return initial;
    const grids=Array.from(root.querySelectorAll('table[aria-rowcount],[role="grid"][aria-rowcount]')).filter(el=>isVisible(el));
    if(grids.length!==1)return initial;
    const grid=grids[0],total=Number(grid.getAttribute('aria-rowcount'));
    if(!Number.isInteger(total)||total<2||total>500||grid.clientHeight<=0||grid.scrollHeight<=grid.clientHeight)return initial;
    const initialIds=(initial.listings??[]).map(row=>String(row.listingId));
    const original=grid.scrollTop,byIndex=new Map(),byId=new Map();
    const headerIndexes=new Set(),details=new Map();
    let valid=true,finished=false;
    const identity=row=>{
      const attr=name=>String(row.getAttribute(name)||'');
      if(initial.marketplace==='mercado_livre'){const id=attr('data-item-id');return /^MLB-?\d{5,}$/i.test(id)?id.toUpperCase():'';}
      if(initial.marketplace==='shopee'){const id=attr('data-product-id')||attr('data-item-id');return /^\d+$/.test(id)?id:'';}
      if(initial.marketplace==='amazon'){const sku=attr('data-sku'),asin=attr('data-asin');return sku?'SKU:'+sku:/^[A-Z0-9]{10}$/.test(asin)?asin:'';}
      return '';
    };
    try{
      grid.scrollTop=0;await wait(350);
      for(let step=0;step<40;step++){
        if(hasChallenge(root)||root.querySelector('input[type="password"], form[action*="login"], form[action*="signin"]'))throw Error('login/CAPTCHA durante a rolagem');
        const snap=readSnapshot();
        if(snap.accountId!==initial.accountId||snap.url!==initial.url||snap.filterSignature!==initial.filterSignature||snap.pageKind!==initial.pageKind||snap.spaPage!==initial.spaPage||snap.coverageWarnings?.includes('FILTRO_NAO_RECONHECIDO'))throw Error('conta, página ou filtros mudaram durante a rolagem');
        if(Number(grid.getAttribute('aria-rowcount'))!==total){valid=false;break;}
        const local=new Map((snap.listings??[]).map(row=>[String(row.listingId),row]));
        for(const row of grid.querySelectorAll('[aria-rowindex]')){
          if(!isVisible(row))continue;
          const idx=Number(row.getAttribute('aria-rowindex'));
          if(!Number.isInteger(idx)||idx<1||idx>total){valid=false;continue;}
          if(row.querySelector?.('[role="columnheader"],th')&&!row.querySelector?.('[role="gridcell"],td')){headerIndexes.add(idx);continue;}
          const id=identity(row),data=local.get(id);
          if(!id||!data||(byIndex.has(idx)&&byIndex.get(idx)!==id)||(byId.has(id)&&byId.get(id).index!==idx)){valid=false;continue;}
          byIndex.set(idx,id);byId.set(id,{index:idx,data});
        }
        for(const detail of snap.details??[]){
          const key=JSON.stringify([detail.kind,detail.parentExternalId??'',detail.externalId]);
          if(!details.has(key)&&details.size>=100){valid=false;continue;}
          details.set(key,detail);
        }
        if(snap.accountMetrics||snap.customerVoice?.length)valid=false;
        const bottom=grid.scrollHeight-grid.clientHeight;
        if(grid.scrollTop>=bottom-1){finished=true;break;}
        const before=grid.scrollTop;
        grid.scrollTop=Math.min(bottom,before+Math.max(1,Math.floor(grid.clientHeight*0.75)));
        await wait(350);
        if(grid.scrollTop<=before){valid=false;break;}
      }
    }finally{grid.scrollTop=original;}
    const complete=valid&&finished&&Array.from({length:total},(_,i)=>i+1).every(i=>headerIndexes.has(i)!==byIndex.has(i))&&byId.size>0;
    if(!complete)return initial;
    return {...initial,initialListingIds:initialIds,listings:[...byId.values()].sort((a,b)=>a.index-b.index).map(row=>row.data),details:[...details.values()],coverageWarnings:initial.coverageWarnings.filter(x=>x!=='TABELA_VIRTUALIZADA'),evidence:{...initial.evidence,virtualizedRows:String(byId.size),virtualizedDeclaredRows:String(total)}};
  }
  function observedReputation(root,marketplace){
    const common={
      sellerCancellationRatePct:['taxa de cancelamento pelo vendedor','seller cancellation rate'],
      complaintRatePct:['taxa de reclamações','complaint rate'],
      onTimeShippingRatePct:['envios no prazo','taxa de envio no prazo','on-time shipping rate'],
      responseRatePct:['taxa de resposta','response rate'],
    };
    const platform=marketplace==='amazon'?{
      orderDefectRatePct:['taxa de pedidos com defeito','order defect rate','odr'],
      lateShipmentRatePct:['taxa de envios atrasados','late shipment rate'],
      validTrackingRatePct:['taxa de rastreamento válido','valid tracking rate'],
    }:marketplace==='shopee'?{
      nonFulfillmentRatePct:['taxa de não cumprimento','non-fulfillment rate'],
      lateShipmentRatePct:['taxa de envio atrasado','late shipment rate'],
      chatResponseRatePct:['taxa de resposta do chat','chat response rate'],
    }:marketplace==='mercado_livre'?{
      lateShipmentRatePct:['envios com atraso','taxa de envios com atraso'],
      mediatedComplaintRatePct:['taxa de reclamações mediadas','mediated complaint rate'],
    }:{};
    const metrics={},evidence={};
    for(const [key,labels] of Object.entries({...common,...platform})){
      const found=explicitPercent(root,labels);
      if(found){metrics[key]=found.value;evidence[key]=found.evidence;}
    }
    return {metrics,evidence};
  }
  function restoreVisibleFilters(root,expected,target,verify=()=>true){
    const state=collectionFilterState(root);
    if(!verify()||state.warnings.length||state.signature!==expected||typeof target!=='string'||target.length>512)return false;
    if(expected===target)return true;
    const parse=signature=>{
      const out=new Map();
      for(const entry of signature.split('|').filter(Boolean)){
        const i=entry.indexOf('=');
        if(i<1||out.has(entry.slice(0,i)))return null;
        out.set(entry.slice(0,i),entry.slice(i+1));
      }
      return out;
    };
    const from=parse(expected),to=parse(target);
    if(!from||!to||from.size!==to.size||[...to.keys()].some(key=>!from.has(key)))return false;
    const regions=Array.from(root.querySelectorAll('[data-testid="filters"],[data-testid="filter-bar"],[role="region"][aria-label]')).filter(el=>isVisible(el)&&(el.getAttribute('data-testid')==='filters'||el.getAttribute('data-testid')==='filter-bar'||/^(filtros|filters|filtros de pesquisa|search filters)$/i.test(String(el.getAttribute('aria-label')||''))));
    if(regions.length!==1)return false;
    const controls=Array.from(regions[0].querySelectorAll('select,input[type="date"],input[type="month"],input[type="week"]')).filter(el=>isVisible(el)&&!el.disabled&&!el.readOnly&&!el.closest('form'));
    const changes=[];
    for(const [key,value] of to){
      if(from.get(key)===value)continue;
      const candidates=controls.filter(el=>normalizeLabel(el.getAttribute('aria-label')||el.getAttribute('name')||el.getAttribute('title')||el.type||'')===key);
      if(candidates.length!==1)return false;
      const control=candidates[0],type=String(control.type||'').toLowerCase();
      let next;
      if(['date','month','week'].includes(type)){
        const pattern=type==='date'?/^\d{4}-\d{2}-\d{2}$/:type==='month'?/^\d{4}-\d{2}$/:/^\d{4}-w\d{2}$/i;
        if(!pattern.test(value))return false;
        next=type==='week'?value.toUpperCase():value;
      }else if(String(control.tagName||'').toUpperCase()==='SELECT'&&!control.multiple){
        const options=Array.from(control.options||[]).filter(option=>!option.disabled&&!option.hidden&&normalizeLabel(option.innerText??option.textContent??'')===value);
        if(options.length!==1)return false;
        next=options[0].value;
      }else return false;
      changes.push({control,next});
    }
    if(!changes.length)return false;
    for(const {control,next} of changes){
      if(!verify()||!isVisible(control)||control.disabled||control.closest('form'))return false;
      const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control),'value')?.set;
      if(setter)setter.call(control,next);else control.value=next;
      if(control.value!==next)return false;
      control.dispatchEvent(new Event('input',{bubbles:true}));
      control.dispatchEvent(new Event('change',{bubbles:true}));
    }
    return true;
  }
  // A chart can be read only when it exposes an explicit visible data table.
  // Axis ticks, pixels and an isolated numeric label are not a data series.
  function visibleChartPoints(root){
    const points=[],keys=new Set(),covered=new Set();
    const regions=Array.from(root.querySelectorAll('[data-chart-id]')).filter(isVisible);
    let incomplete=false;
    for(const region of regions){
      const chartId=String(region.getAttribute('data-chart-id')||'');
      if(!/^[A-Za-z0-9_.:-]{1,120}$/.test(chartId)||regions.filter(el=>el.getAttribute('data-chart-id')===chartId).length!==1){incomplete=true;continue;}
      const tables=String(region.tagName||'').toUpperCase()==='TABLE'?[region]:Array.from(region.querySelectorAll('table')).filter(isVisible);
      if(tables.length!==1){incomplete=true;continue;}
      const table=tables[0],headers=table.tHead?.rows?.length===1?Array.from(table.tHead.rows[0].cells):[];
      const title=String(table.caption&&isVisible(table.caption)?table.caption.innerText??table.caption.textContent??'':region.getAttribute('aria-label')||'').trim();
      if(!title||title.length>150||headers.length<2||headers.length>12||headers.some(el=>!isVisible(el)||(el.colSpan??1)!==1||(el.rowSpan??1)!==1)){incomplete=true;continue;}
      const names=headers.map(el=>String(el.innerText??el.textContent??'').trim());
      if(names.some(name=>!name||name.length>120)||new Set(names.map(normalizeLabel)).size!==names.length||!/^(data|date|período|periodo|period|dia|day|mês|mes|month|hora|hour|categoria|category)$/i.test(names[0])){incomplete=true;continue;}
      const rows=Array.from(table.tBodies||[]).flatMap(body=>Array.from(body.rows||[]));
      if(!rows.length||rows.length>200||Number(table.getAttribute('aria-rowcount')||rows.length+1)>rows.length+1){incomplete=true;continue;}
      const batch=[],seenDimensions=new Set();let ok=true;
      for(const row of rows){
        const cells=Array.from(row.cells||[]);
        if(!isVisible(row)||cells.length!==headers.length||cells.some(el=>!isVisible(el)||(el.colSpan??1)!==1||(el.rowSpan??1)!==1)){ok=false;break;}
        const dimension=String(cells[0].innerText??cells[0].textContent??'').trim();
        if(!dimension||dimension.length>100||seenDimensions.has(dimension)){ok=false;break;}
        seenDimensions.add(dimension);
        for(let k=1;k<cells.length;k++){
          const raw=String(cells[k].innerText??cells[k].textContent??'').trim(),value=parseNumberPtBr(raw),series=names[k];
          if(value===null||raw.length>80){ok=false;break;}
          const unit=/%\s*$/.test(raw)||/\(%\)$/.test(series)?'PERCENT':/^R\$\s*/.test(raw)||/\(R\$\)$/.test(series)?'BRL':'UNSPECIFIED';
          const key=JSON.stringify([chartId,series,dimension]);
          if(keys.has(key)||batch.length+points.length>=200){ok=false;break;}
          batch.push({chartId,chartTitle:title,series,dimension,value,unit,raw});
        }
        if(!ok)break;
      }
      if(!ok){incomplete=true;continue;}
      for(const point of batch){keys.add(JSON.stringify([point.chartId,point.series,point.dimension]));points.push(point);}
      covered.add(region);
    }
    for(const chart of root.querySelectorAll('[data-testid*="chart"] canvas,[class*="chart"] canvas,[data-chart-id] canvas,[data-testid*="chart"] svg,[class*="chart"] svg,[data-chart-id] svg')){
      if(!isVisible(chart))continue;
      const region=chart.closest?.('[data-chart-id]');
      if(!region||!covered.has(region))incomplete=true;
    }
    return {points,incomplete};
  }
  window.MI_DOM = { visibleChartPoints, restoreVisibleFilters, observedReputation, collectVirtualizedListings, spaPaginationState, advanceSpaPage, visibleMoneyParts, collectionFilterState, collectionCoverage, visibleDetailRows, paginationUnsupported, observedExtraMetrics, explicitPercent, visibleCustomerVoice, parseNumberPtBr, findValueByLabel, extractExternalId, isVisible, normalizeLabel, safeNextPageUrl, paginationInfo, hasChallenge };
})();
