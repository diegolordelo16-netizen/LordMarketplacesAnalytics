import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, renameSync, realpathSync } from 'node:fs';
import { join, resolve, relative, dirname, sep, isAbsolute } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const trees=['local-agent','native-host','extension'];
const hex=/^[0-9a-f]{64}$/;
const semver=/^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
const samePath=(a,b)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
const inside=(a,b)=>{const p=relative(resolve(a),resolve(b));return p===''||(!p.startsWith('..'+sep)&&p!=='..'&&!isAbsolute(p)&&!p.includes(':'));};
function plain(path){const st=lstatSync(path);if(st.isSymbolicLink()||(!st.isFile()&&!st.isDirectory()))throw Error('link ou tipo de arquivo recusado: '+path);return st;}
function inventory(root){
  const entries=Object.create(null),caseNames=new Set();let count=0,size=0;
  function visit(path){
    const st=plain(path);
    if(st.isDirectory()){for(const name of readdirSync(path).sort())visit(join(path,name));return;}
    const name=relative(root,path).split(sep).join('/');
    if(!/^[a-zA-Z0-9_.\/-]+$/.test(name)||name.split('/').some(p=>p==='.'||p==='..'||!p))throw Error('nome de arquivo inválido: '+name);
    if(caseNames.has(name.toLowerCase()))throw Error('colisão de nomes em Windows');caseNames.add(name.toLowerCase());
    if(++count>10000||(size+=st.size)>500*1024*1024)throw Error('pacote acima do limite');
    entries[name]={sha256:digest(path),size:st.size};
  }
  for(const t of trees){const p=join(root,t);if(!plain(p).isDirectory())throw Error('diretório obrigatório: '+t);visit(p);}
  return entries;
}
export function buildManifest(root,version,commit){
  if(!semver.test(version)||!/^[a-f0-9]{40}$/.test(commit))throw Error('versão/commit inválido');
  const files=inventory(root);
  if(!files['local-agent/main.js']||!files['native-host/native-host.js']||!files['native-host/register.js']||!files['extension/manifest.json']||!Object.keys(files).some(x=>x.startsWith('local-agent/migrations/')&&x.endsWith('.sql')))throw Error('payload incompleto');
  if(readJson(join(root,'extension','manifest.json')).version!==version)throw Error('versão da extensão divergente');
  return {format:1,version,commit,files};
}
export function verifyPayload(root,expectedDigest){
  if(!hex.test(expectedDigest))throw Error('SHA-256 aprovado necessário');
  const manifest=join(root,'update-manifest.json');if(!plain(manifest).isFile()||digest(manifest)!==expectedDigest)throw Error('manifesto não corresponde ao SHA-256 aprovado');
  const m=readJson(manifest);
  if(m.format!==1||!semver.test(m.version)||!/^[a-f0-9]{40}$/.test(m.commit))throw Error('manifesto inválido');
  const actual=buildManifest(root,m.version,m.commit);
  const expectedKeys=Object.keys(m.files??{}).sort(),actualKeys=Object.keys(actual.files).sort();
  if(JSON.stringify(expectedKeys)!==JSON.stringify(actualKeys))throw Error('inventário do pacote divergente');
  for(const key of actualKeys){if(m.files[key]?.sha256!==actual.files[key].sha256||m.files[key]?.size!==actual.files[key].size)throw Error('arquivo alterado: '+key);}
  return actual;
}
function writeJournal(path,value){const tmp=path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});renameSync(tmp,path);}
function dbSnapshot(source,dest){
  if(!existsSync(source))throw Error('banco local inexistente');
  const db=new DatabaseSync(source);
  try{
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('integridade SQLite inválida');
    db.prepare('VACUUM INTO ?').run(dest);
  }finally{db.close();}
  return digest(dest);
}
function assertTree(root){for(const t of trees)if(!plain(join(root,t)).isDirectory())throw Error('instalação incompleta');inventory(root);}
function versionAt(root){const v=readJson(join(root,'extension','manifest.json')).version;if(!semver.test(v))throw Error('versão instalada inválida');return v;}
function compareVersion(a,b){const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;}
function copyTrees(source,destination){for(const t of trees)cpSync(join(source,t),join(destination,t),{recursive:true,errorOnExist:true,force:false});}
function replaceTrees(source,root){for(const t of trees){rmSync(join(root,t),{recursive:true,force:true});cpSync(join(source,t),join(root,t),{recursive:true,errorOnExist:true,force:false});}}
function assertLocations(root,data,payload){
  if(!samePath(realpathSync(root),root)||!samePath(realpathSync(data),data)||inside(root,data)||inside(data,root))throw Error('raízes sobrepostas ou redirecionadas');
  if(payload&&(inside(root,payload)||inside(data,payload)||inside(payload,root)||inside(payload,data)))throw Error('payload deve ficar fora da instalação e dados');
}
function lock(data){
  const base=join(data,'updates');mkdirSync(base,{recursive:true});if(!plain(base).isDirectory())throw Error('diretório de atualização inválido');
  const marker=join(data,'update-in-progress.json');const token=randomUUID();
  writeFileSync(marker,JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600});
  return {base,marker,token,release:()=>rmSync(marker,{force:true})};
}
function checkState(s,root,data,base){
  if(!s||!semver.test(s.from)||!semver.test(s.to)||!/^[a-f0-9-]{36}$/.test(s.id)||!samePath(s.root,root)||!samePath(s.data,data))throw Error('registro de atualização inválido');
  const backup=join(base,s.id,'previous');assertTree(backup);
  const dbFile=join(base,s.id,'before.db');if(!plain(dbFile).isFile()||digest(dbFile)!==s.dbSha256)throw Error('backup SQLite inválido');
  const actual=inventory(backup);if(JSON.stringify(actual)!==JSON.stringify(s.previousFiles))throw Error('backup dos arquivos alterado');
  return {backup,dbFile};
}
async function restore(s,root,data,base,hooks,token){
  const {backup,dbFile}=checkState(s,root,data,base);
  await hooks.quiesce(root);
  const database=join(data,'marketplace-intelligence.db');
  if(existsSync(database))dbSnapshot(database,join(base,s.id,'before-rollback-'+randomUUID()+'.db'));
  replaceTrees(backup,root);
  for(const suffix of ['-wal','-shm','-journal'])rmSync(database+suffix,{force:true});
  cpSync(dbFile,database,{force:true});
  if(digest(database)!==s.dbSha256)throw Error('restauração SQLite divergente');
  await hooks.startAndVerify(root,data,s.from,token,false);
}
export async function installUpdate({root,data,payload,expectedDigest,approved,hooks}){
  if(approved!==true)throw Error('aprovação explícita necessária');
  root=resolve(root);data=resolve(data);payload=resolve(payload);
  assertLocations(root,data,payload);assertTree(root);
  const verified=verifyPayload(payload,expectedDigest),from=versionAt(root);
  if(compareVersion(verified.version,from)<=0)throw Error('use rollback para voltar a uma versão anterior');
  const guard=lock(data),journal=join(guard.base,'current.json');
  let state=null;
  try{
    if(existsSync(journal)){const prior=readJson(journal);if(!['APPLIED','ROLLED_BACK'].includes(prior.phase))throw Error('recupere a atualização anterior antes de continuar');}
    await hooks.quiesce(root);
    const id=randomUUID(),dir=join(guard.base,id),backup=join(dir,'previous'),staged=join(dir,'staged');
    mkdirSync(backup,{recursive:true});mkdirSync(staged);
    copyTrees(root,backup);copyTrees(payload,staged);cpSync(join(payload,'update-manifest.json'),join(staged,'update-manifest.json'));
    verifyPayload(staged,expectedDigest);
    const dbSha256=dbSnapshot(join(data,'marketplace-intelligence.db'),join(dir,'before.db'));
    state={id,root,data,from,to:verified.version,commit:verified.commit,approvedManifestSha256:expectedDigest,previousFiles:inventory(backup),dbSha256,phase:'PREPARED',at:new Date().toISOString()};
    writeJournal(join(dir,'journal.json'),state);writeJournal(journal,state);
    state.phase='INSTALLING';writeJournal(journal,state);
    replaceTrees(staged,root);
    if(versionAt(root)!==state.to||JSON.stringify(inventory(root))!==JSON.stringify(verified.files))throw Error('arquivos instalados não conferem');
    await hooks.startAndVerify(root,data,state.to,guard.token,true);
    state.phase='APPLIED';state.finishedAt=new Date().toISOString();writeJournal(journal,state);writeJournal(join(dir,'journal.json'),state);
    return {ok:true,version:state.to,backupId:id};
  }catch(e){
    if(state&&state.phase==='INSTALLING'){
      try{await restore(state,root,data,guard.base,hooks,guard.token);state.phase='ROLLED_BACK';}
      catch(err){state.phase='RECOVERY_REQUIRED';state.rollbackError=String(err);}
      state.error=String(e);writeJournal(journal,state);
    }
    throw e;
  }finally{guard.release();}
}
export async function rollbackUpdate({root,data,approved,hooks}){
  if(approved!==true)throw Error('aprovação explícita de rollback necessária');
  root=resolve(root);data=resolve(data);assertLocations(root,data);
  const guard=lock(data),journal=join(guard.base,'current.json');
  try{
    const state=readJson(journal);
    if(!['APPLIED','INSTALLING','RECOVERY_REQUIRED','PREPARED'].includes(state.phase))throw Error('não há atualização reversível');
    checkState(state,root,data,guard.base);
    state.phase='RECOVERY_REQUIRED';writeJournal(journal,state);
    await restore(state,root,data,guard.base,hooks,guard.token);
    state.phase='ROLLED_BACK';state.rolledBackAt=new Date().toISOString();writeJournal(journal,state);
    return {ok:true,version:state.from,backupId:state.id};
  }finally{guard.release();}
}
export async function recoverUpdate({root,data,approved,hooks}){
  if(approved!==true)throw Error('aprovação explícita de recuperação necessária');
  root=resolve(root);data=resolve(data);assertLocations(root,data);
  const marker=join(data,'update-in-progress.json'),journal=join(data,'updates','current.json');
  if(existsSync(marker)){
    const state=readJson(marker);
    if(!Number.isSafeInteger(state.pid)||state.pid<=0)throw Error('marcador inválido; revisão manual necessária');
    let alive=true;try{process.kill(state.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
    if(alive)throw Error('processo do atualizador ainda ativo');
    rmSync(marker);
  }
  if(!existsSync(journal))return {ok:true,note:'nenhuma alteração iniciada; execute novamente a instalação'};
  const state=readJson(journal);
  if(['APPLIED','ROLLED_BACK'].includes(state.phase))return {ok:true,version:versionAt(root),note:'transação já concluída'};
  return rollbackUpdate({root,data,approved:true,hooks});
}
async function windowsQuiesce(root){
  if(process.platform!=='win32')throw Error('instalação suportada somente no Windows');
  const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true});
  const parsed=raw.trim()?JSON.parse(raw):[],rows=Array.isArray(parsed)?parsed:[parsed];
  const owned=rows.filter(p=>p.ExecutablePath&&samePath(p.ExecutablePath,join(root,'node.exe'))&&Number(p.ProcessId)!==process.pid);
  if(owned.some(p=>!p.CommandLine?.includes('--serve')||p.CommandLine.includes('--host')))throw Error('feche Chrome/Edge e outros processos do Marketplace Intelligence antes de atualizar');
  for(const p of owned)process.kill(Number(p.ProcessId));
  for(let i=0;i<30;i++){if(owned.every(p=>{try{process.kill(Number(p.ProcessId),0);return false;}catch{return true;}}))return;await new Promise(r=>setTimeout(r,200));}
  throw Error('serviço não encerrou');
}
async function startAndVerify(root,data,version,token,requireVersion){
  const portFile=join(data,'port.txt'),urlFile=join(data,'panel-url.txt');
  rmSync(portFile,{force:true});rmSync(urlFile,{force:true});
  const child=spawn(join(root,'node.exe'),[join(root,'local-agent','main.js'),'--serve','--port=0','--data='+data],{detached:true,stdio:'ignore',windowsHide:true,env:{...process.env,MI_UPDATE_HEALTH_TOKEN:token}});
  let failed=false;child.on('error',()=>{failed=true;});child.on('exit',()=>{failed=true;});child.unref();
  for(let i=0;i<60&&!failed;i++){
    await new Promise(r=>setTimeout(r,500));
    try{
      const port=Number(readFileSync(portFile,'utf8').trim());
      if(!Number.isInteger(port)||port<1||port>65535)continue;
      const res=await fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(1000)});
      const health=await res.json();
      if(res.ok&&health.ok===true&&(!requireVersion||health.version===version))return;
    }catch{}
  }
  try{child.kill();}catch{}
  throw Error('a versão não iniciou ou não passou no health check');
}
async function cli(){
  const [action,...args]=process.argv.slice(2),root=dirname(fileURLToPath(import.meta.url));
  if(action==='manifest'){const [payload,version,commit]=args;const m=buildManifest(resolve(payload),version,commit);const path=join(payload,'update-manifest.json');writeFileSync(path,JSON.stringify(m,null,2));console.log(digest(path));return;}
  if(process.platform!=='win32'||!process.env.LOCALAPPDATA)throw Error('Windows e LOCALAPPDATA necessários');
  const data=join(process.env.LOCALAPPDATA,'MarketplaceIntelligence'),hooks={quiesce:windowsQuiesce,startAndVerify};
  if(action==='install'&&args.length===3&&args[2]==='--approve'){console.log(await installUpdate({root,data,payload:args[0],expectedDigest:args[1],approved:true,hooks}));return;}
  if(action==='rollback'&&args.length===1&&args[0]==='--approve'){console.log(await rollbackUpdate({root,data,approved:true,hooks}));return;}
  if(action==='recover'&&args.length===1&&args[0]==='--approve'){console.log(await recoverUpdate({root,data,approved:true,hooks}));return;}
  throw Error('Uso: node.exe update-manager.mjs install <pasta do artefato> <SHA-256 aprovado> --approve | rollback --approve | recover --approve');
}
if(process.argv[1]&&samePath(process.argv[1],fileURLToPath(import.meta.url)))cli().catch(e=>{console.error(e.message);process.exitCode=1;});
