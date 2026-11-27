import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { windowsQuiesce } from './update-manager.mjs';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw Error('Smoke exclusivo de runner Windows descartável.');
const host = 'com.marketplaceintelligence.host';
const keys = ['HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + host,
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\' + host];
const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const reg = (...args) => spawnSync('reg.exe', args, { encoding:'utf8', windowsHide:true, timeout:10000 });
const registered = key => reg('query',key,'/ve').status === 0;
const autostart = () => reg('query',runKey,'/v','MarketplaceIntelligence').status === 0;
assert.ok(keys.every(key => !registered(key)) && !autostart(), 'Runner deve começar sem registros do produto.');
const work = mkdtempSync(join(tmpdir(), 'mi-installer-smoke-'));
const root = join(work,'Installed Marketplace Intelligence'), local = join(work,'Local AppData = QA');
const data = join(local,'MarketplaceIntelligence');
mkdirSync(data,{recursive:true});
const env = {...process.env,LOCALAPPDATA:local,MI_ADMIN_PASSWORD:'ci-only-installer-fixture-2026'};
const setup = resolve('installer/output/MarketplaceIntelligence-Setup.exe');
const version = JSON.parse(readFileSync('package.json','utf8')).version;
function run(file,args,options={}){
  const result=spawnSync(file,args,{env,windowsHide:true,timeout:120000,encoding:'utf8',...options});
  if(result.error) throw result.error;
  assert.equal(result.status,0,'Processo falhou: '+file+'\n'+String(result.stderr??'').slice(0,2000));
  return result;
}
function readShortcuts(){
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $shell = New-Object -ComObject WScript.Shell
    $desktop = Join-Path ($shell.SpecialFolders.Item('Desktop')) 'Marketplace Intelligence.lnk'
    $group = Join-Path ($shell.SpecialFolders.Item('Programs')) 'Marketplace Intelligence'
    $prestart = (Get-ChildItem -LiteralPath $group -Filter '*diagn*.lnk').FullName
    @($desktop, $prestart) | ForEach-Object {
      if (-not (Test-Path -LiteralPath $_)) { throw "Atalho ausente: $_" }
      $shell.CreateShortcut($_) | Select-Object FullName, TargetPath, Arguments, WorkingDirectory
    } | ConvertTo-Json -Compress
  `;
  const command = Buffer.from(script, 'utf16le').toString('base64');
  return JSON.parse(run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',command]).stdout);
}
const execute = promisify(execFile);
const launcherLog = join(data,'logs','launcher.log');
async function runShortcut(shortcut, argument){
  assert.equal(shortcut.TargetPath,join(root,'MarketplaceIntelligence.exe'));
  assert.equal(shortcut.Arguments,argument);
  assert.equal(shortcut.WorkingDirectory,root);
  try {
    // Executa o destino e os parâmetros gravados pelo Inno, herdando o perfil isolado do teste.
    await execute(shortcut.TargetPath, argument ? [argument] : [], {
      cwd:shortcut.WorkingDirectory,env,windowsHide:true,timeout:60000,
    });
  } catch (error) {
    const log = existsSync(launcherLog) ? readFileSync(launcherLog,'utf8').slice(-3000) : 'Log ausente';
    throw new Error('O atalho não concluiu a abertura do painel.\n'+log,{cause:error});
  }
}
let uninstallCompleted=false;
function uninstall(){
  if(uninstallCompleted)return;
  if(!existsSync(root))return;
  const exe=readdirSync(root).find(name=>/^unins\d+\.exe$/i.test(name));
  if(exe){
    run(join(root,exe),['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/LOG='+join(work,'uninstall.log')]);
    uninstallCompleted=true;
  }
}
try{
  run(setup,['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CURRENTUSER','/TASKS=desktopicon','/DIR='+root,'/LOG='+join(work,'install.log')]);
  assert.ok(existsSync(join(root,'node.exe')));
  assert.ok(existsSync(join(root,'start-panel.mjs')));
  assert.equal(autostart(),false,'Não registrar startup sem autorização');
  const manifests = keys.map(key=>{
    const result=reg('query',key,'/ve');
    assert.equal(result.status,0,'Registro ausente: '+key);
    const path=result.stdout.match(/REG_SZ\s+([^\r\n]+)/)?.[1]?.trim();
    assert.ok(path && existsSync(path),'Manifesto ausente');
    return JSON.parse(readFileSync(path,'utf8'));
  });
  assert.deepEqual(manifests[0],manifests[1]);
  const manifest=manifests[0];
  assert.equal(manifest.path,join(root,'native-host','native-host.bat'));
  assert.ok(existsSync(manifest.path));
  assert.match(manifest.allowed_origins[0],/^chrome-extension:\/\/[a-p]{32}\/$/);
  const json=Buffer.from(JSON.stringify({id:'ci-native-ping',protocolVersion:1,method:'ping',payload:{}}));
  const header=Buffer.alloc(4);header.writeUInt32LE(json.length);
  const hostRun=run('cmd.exe',['/d','/s','/c','""'+manifest.path+'" '+manifest.allowed_origins[0]+' --parent-window=0"'],{input:Buffer.concat([header,json]),encoding:null,windowsVerbatimArguments:true,timeout:30000});
  const frame=hostRun.stdout;
  assert.ok(frame.length>=4);
  const len=frame.readUInt32LE(0);
  assert.equal(frame.length,len+4,'stdout deve conter apenas um frame nativo');
  const reply=JSON.parse(frame.subarray(4).toString('utf8'));
  assert.equal(reply.id,'ci-native-ping');assert.equal(reply.ok,true);
  const [desktop,prestart] = readShortcuts();
  const occupied = createServer((_req,res) => res.end(JSON.stringify({ok:true,protocolVersion:0})));
  occupied.listen(47811,'127.0.0.1');
  await once(occupied,'listening');
  let port;
  try {
    const occupiedPort = occupied.address().port;
    writeFileSync(join(data,'port.txt'),String(occupiedPort));
    await runShortcut(desktop,'');
    port = Number(readFileSync(join(data,'port.txt'),'utf8').trim());
    assert.notEqual(port,occupiedPort,'O serviço deve usar uma porta livre');
  } finally {
    await new Promise(resolve => occupied.close(resolve));
  }
  const url = 'http://127.0.0.1:'+port+'/';
  const health=await fetch(url+'api/health',{signal:AbortSignal.timeout(3000)});
  assert.equal(health.ok,true);
  assert.equal((await health.json()).version,version);
  assert.equal(readFileSync(join(data,'panel-url.txt'),'utf8').trim(),url);
  assert.ok(readFileSync(launcherLog,'utf8').split(/\r?\n/).some(line => line.endsWith('Navegador aberto: '+url)));
  await runShortcut(prestart,'--prestart');
  assert.equal(Number(readFileSync(join(data,'port.txt'),'utf8').trim()),port,'O atalho de diagnóstico deve reutilizar o serviço');
  assert.ok(readFileSync(launcherLog,'utf8').split(/\r?\n/).some(line => line.endsWith('Navegador aberto: '+url+'prestart')));
  for (const [path, title] of [['prestart','Pré-Start &amp; Diagnóstico'],['app','Visão executiva']]) {
    const page = await fetch(url+path,{signal:AbortSignal.timeout(3000)});
    assert.equal(page.status,200);
    assert.ok((await page.text()).includes(title),'Página esperada em /'+path);
  }
  await windowsQuiesce(root);
  const db=new DatabaseSync(join(data,'marketplace-intelligence.db'));
  db.exec("CREATE TABLE ci_installer_probe (id INTEGER PRIMARY KEY); INSERT INTO ci_installer_probe VALUES(1)");db.close();
  uninstall();
  assert.ok(keys.every(key=>!registered(key)));
  assert.equal(autostart(),false);
  assert.ok(!existsSync(join(root,'node.exe')),'Runtime deve ser removido');
  assert.ok(!existsSync(desktop.FullName) && !existsSync(prestart.FullName),'Atalhos devem ser removidos');
  const persisted=new DatabaseSync(join(data,'marketplace-intelligence.db'),{readOnly:true});
  assert.equal(persisted.prepare('SELECT id FROM ci_installer_probe').get().id,1);
  persisted.close();
  console.log('OK instalador real, registro Chrome/Edge, frame nativo, atalhos interativos, porta ocupada, preservação de dados e desinstalação.');
}finally{
  try{if(existsSync(join(root,'node.exe')))await windowsQuiesce(root);}
  finally{try{uninstall();}finally{rmSync(work,{recursive:true,force:true,maxRetries:20,retryDelay:250});}}
}
