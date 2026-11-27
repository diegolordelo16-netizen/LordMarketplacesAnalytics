import { Buffer } from 'node:buffer';
type Report={type:string;generatedAt:string;scope:string;filters:unknown;summary:unknown;note:string;rows:Array<Record<string,unknown>>;offset:number;nextOffset:number|null};
function safeText(value:unknown):string{
  if(value===null||value===undefined)return '— (não informado)';
  return typeof value==='object'?JSON.stringify(value):String(value);
}
function literal(s:string):string{
  // PDF standard Helvetica/WinAnsi, with ASCII octal escapes for all non-ASCII.
  const map:Record<string,number>={'€':128,'‘':145,'’':146,'“':147,'”':148,'–':150,'—':151,'…':133};
  return Array.from(s.normalize('NFC')).map(ch=>{
    const n=map[ch]??ch.charCodeAt(0);
    if(n>=32&&n<=126)return /[\\()]/.test(ch)?'\\'+ch:ch;
    if(n>=160&&n<=255||Object.hasOwn(map,ch))return '\\'+n.toString(8).padStart(3,'0');
    return n===10||n===13||n===9?' ':'?';
  }).join('');
}
function wrap(s:string,width=92):string[]{
  const out:string[]=[];
  for(const line of s.replace(/\r/g,'').split('\n')){
    let rest=line;
    while(rest.length>width){let end=rest.lastIndexOf(' ',width);if(end<width/2)end=width;out.push(rest.slice(0,end));rest=rest.slice(end).trimStart();}
    out.push(rest);
  }
  return out;
}
export function renderReportPdf(r:Report):Buffer{
  const lines:string[]=[...wrap('Escopo: '+r.scope),...wrap('Filtros: '+safeText(r.filters)),...wrap('Gerado: '+r.generatedAt),...wrap(r.note),...wrap('Resumo: '+safeText(r.summary)),...wrap('Registros nesta parte: '+r.rows.length+' | início: '+r.offset+(r.nextOffset!==null?' | próxima parte: '+r.nextOffset:'')),''];
  r.rows.forEach((row,index)=>{
    lines.push('Registro '+(r.offset+index+1));
    for(const [key,value] of Object.entries(row))lines.push(...wrap(key+': '+safeText(value)));
    lines.push('');
  });
  if(lines.length>6000)throw Error('PDF excede limite de páginas; reduza o número de registros por exportação');
  const pages:string[][]=[];
  for(let i=0;i<lines.length;i+=48)pages.push(lines.slice(i,i+48));
  const objects:string[]=[];
  const add=(value:string)=>{objects.push(value);return objects.length;};
  add('<< /Type /Catalog /Pages 2 0 R >>');add('');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const ids:number[]=[];
  pages.forEach((page,index)=>{
    const commands=['BT /F1 15 Tf 40 800 Td ('+literal('Marketplace Intelligence | '+r.type)+') Tj ET','BT /F1 9 Tf 40 770 Td 14 TL',...page.map((line,i)=>(i?'T* ':'')+'('+literal(line)+') Tj'),'ET','BT /F1 9 Tf 40 38 Td ('+literal('Página '+(index+1)+' de '+pages.length)+') Tj ET'].join('\n');
    const content=add('<< /Length '+Buffer.byteLength(commands,'ascii')+' >>\nstream\n'+commands+'\nendstream');
    ids.push(add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents '+content+' 0 R >>'));
  });
  objects[1]='<< /Type /Pages /Count '+ids.length+' /Kids ['+ids.map(id=>id+' 0 R').join(' ')+'] >>';
  let output='%PDF-1.4\n';const offsets=[0];
  objects.forEach((value,i)=>{offsets.push(Buffer.byteLength(output,'ascii'));output+=(i+1)+' 0 obj\n'+value+'\nendobj\n';});
  const xref=Buffer.byteLength(output,'ascii');
  output+='xref\n0 '+offsets.length+'\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
  const bytes=Buffer.from(output,'ascii');if(bytes.length>1500000)throw Error('PDF excede limite local; reduza a página de registros');
  return bytes;
}
