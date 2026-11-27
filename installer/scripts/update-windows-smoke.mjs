import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildManifest, installUpdate, rollbackUpdate, windowsQuiesce, startAndVerify } from './update-manager.mjs';
if(process.platform!=='win32')throw Error('Windows runner required');
const version=JSON.parse(readFileSync('package.json','utf8')).version;
const [major,minor,patch]=version.split('.').map(Number);
const previous=patch>0?[major,minor,patch-1].join('.'):minor>0?[major,minor-1,999].join('.'):[major-1,999,999].join('.');
const dir=mkdtempSync(join(tmpdir(),'mi-real-upgrade-')),root=join(dir,'installed'),data=join(dir,'data'),payload=join(dir,'payload');
const trees=['local-agent','native-host','extension'];
try{
  mkdirSync(root);mkdirSync(data);mkdirSync(payload);
  for(const t of trees){cpSync(resolve('dist',t),join(payload,t),{recursive:true});cpSync(resolve('dist',t),join(root,t),{recursive:true});}
  cpSync(process.execPath,join(root,'node.exe'));
  // Synthetic prior version uses the real compiled service with only its version label changed.
  // No historical release or marketplace credentials are required for this isolated smoke.
  const priorMain=join(root,'local-agent/main.js'),source=readFileSync(priorMain,'utf8');
  assert.ok(source.includes(JSON.stringify(version)));
  writeFileSync(priorMain,source.replaceAll(JSON.stringify(version),JSON.stringify(previous)));
  const priorManifest=join(root,'extension/manifest.json'),manifest=JSON.parse(readFileSync(priorManifest,'utf8'));
  manifest.version=previous;writeFileSync(priorManifest,JSON.stringify(manifest));
  const m=buildManifest(payload,version,'a'.repeat(40)),mp=join(payload,'update-manifest.json');
  writeFileSync(mp,JSON.stringify(m,null,2));
  const expectedDigest=createHash('sha256').update(readFileSync(mp)).digest('hex');
  process.env.MI_ADMIN_PASSWORD='ci-only-fixture-password-2026';
  await startAndVerify(root,data,previous,'',true);
  assert.ok(existsSync(join(data,'marketplace-intelligence.db')));
  await windowsQuiesce(root);
  const db=new DatabaseSync(join(data,'marketplace-intelligence.db'));
  db.exec("CREATE TABLE ci_update_probe (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO ci_update_probe VALUES(1,'before')");db.close();
  const hooks={quiesce:windowsQuiesce,startAndVerify};
  const applied=await installUpdate({root,data,payload,expectedDigest,approved:true,hooks});
  assert.equal(applied.version,version);
  await windowsQuiesce(root);
  const updated=new DatabaseSync(join(data,'marketplace-intelligence.db'));
  assert.equal(updated.prepare('SELECT value FROM ci_update_probe WHERE id=1').get().value,'before');
  updated.exec("INSERT INTO ci_update_probe VALUES(2,'after')");updated.close();
  assert.equal((await rollbackUpdate({root,data,approved:true,hooks})).version,previous);
  await windowsQuiesce(root);
  const restored=new DatabaseSync(join(data,'marketplace-intelligence.db'));
  assert.deepEqual(restored.prepare('SELECT value FROM ci_update_probe ORDER BY id').all().map(x=>x.value),['before']);
  restored.close();
  console.log('OK actual Windows service boot, update, SQLite preservation and rollback');
}finally{
  try{await windowsQuiesce(root);}finally{rmSync(dir,{recursive:true,force:true});}
}
