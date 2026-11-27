import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildManifest, verifyPayload, installUpdate, rollbackUpdate, recoverUpdate } from './update-manager.mjs';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function tree(root,version){
  for(const name of ['local-agent/migrations','native-host','extension'])mkdirSync(join(root,name),{recursive:true});
  writeFileSync(join(root,'local-agent/main.js'),version);
  writeFileSync(join(root,'local-agent/migrations/001.sql'),'SELECT 1;');
  writeFileSync(join(root,'native-host/native-host.js'),version);
  writeFileSync(join(root,'native-host/register.js'),version);
  writeFileSync(join(root,'extension/manifest.json'),JSON.stringify({version}));
}
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'mi-upgrade-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const root=join(dir,'installed'),data=join(dir,'data'),payload=join(dir,'payload');mkdirSync(data);
  tree(root,'3.16.0');tree(payload,'3.17.0');
  writeFileSync(join(root,'local-agent/migrations/legacy.sql'),'SELECT 2;');
  const dbPath=join(data,'marketplace-intelligence.db');
  const db=new DatabaseSync(dbPath);db.exec("CREATE TABLE evidence(v TEXT); INSERT INTO evidence VALUES('before')");db.close();
  const m=buildManifest(payload,'3.17.0','a'.repeat(40));const p=join(payload,'update-manifest.json');writeFileSync(p,JSON.stringify(m,null,2));
  const expectedDigest=hash(p);
  const versions=[];const hooks={quiesce:async()=>{},startAndVerify:async(_r,_d,v)=>{versions.push(v);}};
  const readDb=()=>{const d=new DatabaseSync(dbPath);try{return d.prepare('SELECT v FROM evidence ORDER BY rowid').all().map(x=>x.v);}finally{d.close();}};
  return {root,data,payload,expectedDigest,approved:true,hooks,dbPath,versions,readDb};
}
test('requires approval and verifies manifest and every file before writes',async t=>{
  const f=fixture(t);
  await assert.rejects(installUpdate({...f,approved:false}),/aprovação/);
  await assert.rejects(installUpdate({...f,expectedDigest:'0'.repeat(64)}),/SHA-256/);
  writeFileSync(join(f.payload,'local-agent/main.js'),'tampered');
  await assert.rejects(installUpdate(f),/arquivo alterado/);
  assert.equal(readFileSync(join(f.root,'local-agent/main.js'),'utf8'),'3.16.0');
  assert.deepEqual(f.readDb(),['before']);
});
test('installs and rolls back all versioned trees and consistent SQLite snapshot',async t=>{
  const f=fixture(t);assert.equal(verifyPayload(f.payload,f.expectedDigest).version,'3.17.0');
  assert.equal((await installUpdate(f)).version,'3.17.0');
  assert.equal(readFileSync(join(f.root,'local-agent/main.js'),'utf8'),'3.17.0');
  assert.equal(existsSync(join(f.root,'local-agent/migrations/legacy.sql')),false);
  const db=new DatabaseSync(f.dbPath);db.exec("INSERT INTO evidence VALUES('after')");db.close();
  assert.equal((await rollbackUpdate(f)).version,'3.16.0');
  assert.equal(readFileSync(join(f.root,'native-host/native-host.js'),'utf8'),'3.16.0');
  assert.equal(existsSync(join(f.root,'local-agent/migrations/legacy.sql')),true);
  assert.deepEqual(f.readDb(),['before']);assert.deepEqual(f.versions,['3.17.0','3.16.0']);
  assert.equal(existsSync(join(f.data,'update-in-progress.json')),false);
});
test('failed health check triggers automatic rollback instead of claiming success',async t=>{
  const f=fixture(t);f.hooks.startAndVerify=async(_r,_d,v)=>{f.versions.push(v);if(v==='3.17.0')throw Error('health failed');};
  await assert.rejects(installUpdate(f),/health failed/);
  assert.equal(readFileSync(join(f.root,'local-agent/main.js'),'utf8'),'3.16.0');
  assert.deepEqual(f.readDb(),['before']);
  assert.equal(JSON.parse(readFileSync(join(f.data,'updates/current.json'),'utf8')).phase,'ROLLED_BACK');
});
test('refuses extra payload files and corrupted backup',async t=>{
  const f=fixture(t);const extra=join(f.payload,'extension/extra.js');writeFileSync(extra,'extra');
  assert.throws(()=>verifyPayload(f.payload,f.expectedDigest),/inventário/);rmSync(extra);
  const installed=await installUpdate(f);
  writeFileSync(join(f.data,'updates',installed.backupId,'previous/local-agent/main.js'),'tampered');
  await assert.rejects(rollbackUpdate(f),/backup dos arquivos alterado/);
  assert.equal(readFileSync(join(f.root,'local-agent/main.js'),'utf8'),'3.17.0');
});
test('recovery refuses an active updater and handles a completed journal',async t=>{
  const f=fixture(t);await installUpdate(f);
  const marker=join(f.data,'update-in-progress.json');writeFileSync(marker,JSON.stringify({pid:process.pid,token:'active'}));
  await assert.rejects(recoverUpdate(f),/ainda ativo/);rmSync(marker);
  assert.equal((await recoverUpdate(f)).version,'3.17.0');
});

test('failed recovery keeps a durable startup fence',async t=>{
  const f=fixture(t);f.hooks.startAndVerify=async()=>{throw Error('health failed');};
  await assert.rejects(installUpdate(f),/health failed/);
  assert.equal(JSON.parse(readFileSync(join(f.data,'updates/current.json'),'utf8')).phase,'RECOVERY_REQUIRED');
  assert.equal(existsSync(join(f.data,'update-in-progress.json')),true);
});
