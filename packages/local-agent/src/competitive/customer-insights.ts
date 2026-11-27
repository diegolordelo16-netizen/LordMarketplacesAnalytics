type Item={id:string;kind:string;source_class:string;listing_id:string|null;text_redacted:string;rating:number|null;observed_at:string};
const categories=[
  {key:'SIZE_FIT',label:'Tamanho e compatibilidade',pattern:/\b(tamanho|medida|serve|compat[ií]vel|apertad[oa]|folgad[oa])\b/i,action:'Revisar medidas, tabela e compatibilidade na descrição.'},
  {key:'QUALITY',label:'Qualidade e defeito',pattern:/\b(defeit[oa]s?|quebrad[oa]|rasgad[oa]|rachad[oa]|danificad[oa]|costura|vazamento)\b/i,action:'Investigar lote e inspecionar produto antes do envio.'},
  {key:'DELIVERY',label:'Entrega e embalagem',pattern:/\b(atras[oa]s?|atrasad[oa]|frete|entrega|embalagem|transportadora)\b/i,action:'Revisar prazo prometido e proteção da embalagem.'},
  {key:'DESCRIPTION',label:'Descrição e divergência',pattern:/\b(diferente|descri[cç][aã]o|foto|imagem|cor|modelo|an[uú]ncio)\b/i,action:'Conferir a fidelidade das fotos, atributos e descrição.'},
  {key:'PRICE',label:'Preço e condições',pattern:/\b(pre[cç]o|desconto|car[oa]|barat[oa]|parcelamento|promo[cç][aã]o)\b/i,action:'Revisar condições comerciais sem alterar preços automaticamente.'},
  {key:'USE',label:'Uso e instruções',pattern:/\b(como usar|instala[cç][aã]o|manual|montagem|funciona|garantia)\b/i,action:'Revisar instruções e perguntas frequentes.'},
] as const;
export function customerInsights(items:Item[]){
  const groups=new Map<string,{category:string;label:string;kind:string;source:string;count:number;listingIds:Set<string>;evidenceIds:string[];action:string}>();
  for(const item of items){
    for(const category of categories){
      if(!category.pattern.test(item.text_redacted))continue;
      const id=JSON.stringify([category.key,item.kind,item.source_class]);
      const row=groups.get(id)??{category:category.key,label:category.label,kind:item.kind,source:item.source_class,count:0,listingIds:new Set<string>(),evidenceIds:[],action:category.action};
      row.count++;if(item.listing_id)row.listingIds.add(item.listing_id);
      if(row.evidenceIds.length<10)row.evidenceIds.push(item.id);groups.set(id,row);
    }
  }
  return [...groups.values()].sort((a,b)=>b.count-a.count||a.category.localeCompare(b.category)).map(({listingIds,...row})=>({...row,listingCount:listingIds.size,classification:'LEXICAL_MENTION_NOT_CONFIRMED_PROBLEM',recurring:row.count>=2}));
}
export function compareCatalogText(ownTitle:string,rivalTitle:string,ownAttributes:Record<string,unknown>,rivalAttributes:Record<string,unknown>){
  const tokens=(value:string)=>[...new Set(value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu,'').split(/[^\p{L}\p{N}]+/u).filter(t=>t.length>=3&&!['para','com','sem','das','dos','uma'].includes(t)))];
  const a=tokens(ownTitle),b=tokens(rivalTitle),common=a.filter(t=>b.includes(t));
  const key=(v:string)=>v.normalize('NFKC').toLowerCase().trim();
  const rival=new Map(Object.entries(rivalAttributes).filter(([,v])=>typeof v==='string'&&v.trim()).map(([k,v])=>[key(k),String(v)]));
  const own=new Map(Object.entries(ownAttributes).filter(([,v])=>typeof v==='string'&&v.trim()).map(([k,v])=>[key(k),String(v)]));
  return {commonTerms:common,rivalOnlyTerms:b.filter(t=>!a.includes(t)),ownOnlyTerms:a.filter(t=>!b.includes(t)),attributeDifferences:[...rival].map(([attribute,value])=>({attribute,own:own.get(attribute)??null,rival:value})).filter(r=>r.own===null||key(r.own)!==key(r.rival)),note:'Comparação lexical dos títulos e atributos cadastrados; não comprova qualidade, descrição completa ou demanda.'};
}
