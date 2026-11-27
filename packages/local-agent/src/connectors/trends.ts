import { parseCsvText } from '../importers/tabular';
import { validDay } from './sync';
export function parseTrendsCsv(text:string){
  const cleaned=text.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
  const lines=cleaned.split('\n');
  const idx=lines.findIndex(line=>/^\s*"?\s*(dia|day|data|date|semana|week|mês|mes|month)\s*"?\s*[,;\t]/i.test(line));
  if(idx<0)throw Error('CSV deve conter cabeçalho de interesse ao longo do tempo');
  const rows=parseCsvText(lines.slice(idx).join('\n')),out:Array<{key:string;date:string;values:Record<string,string|number|null>}>=[];
  const seen=new Set<string>();
  for(const row of rows){
    const keys=Object.keys(row),dateRaw=String(row[keys[0]!]??'').trim();
    const date=/^\d{4}-\d{2}$/.test(dateRaw)?dateRaw+'-01':dateRaw;
    if(!validDay(date)||date>new Date().toISOString().slice(0,10))throw Error('data inválida no Trends');
    for(const term of keys.slice(1)){
      const value=String(row[term]??'').trim();if(!value)continue;
      if(value!=='<1'&&!/^(?:100|[0-9]{1,2})$/.test(value))throw Error('interesse Trends deve ser 0–100 ou <1');
      const key=date+'|'+term;if(seen.has(key))throw Error('data/termo duplicado');
      seen.add(key);
      out.push({key,date,values:{term,index:value==='<1'?null:Number(value),qualifier:value==='<1'?'LT_1':null,originalDate:dateRaw,sourceClass:'F_USER_INPUT'}});
      if(out.length>10000)throw Error('limite de 10000 observações Trends');
    }
  }
  if(!out.length)throw Error('nenhum interesse de pesquisa observado');
  const dates=out.map(x=>x.date).sort();
  return {rows:out,from:dates[0]!,to:dates.at(-1)!,note:'Exportação declarada pelo operador. Índice relativo à própria amostra e período; <1 não é zero. Não é volume absoluto nem demanda de marketplace.'};
}
