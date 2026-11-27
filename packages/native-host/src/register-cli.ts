/**
 * Registra/remove o host de mensagens nativas no Windows (HKCU).
 * Chamado pelo instalador — nunca pelo navegador.
 *
 * Uso:
 *   node register.js                      registra para Chrome e Edge
 *   node register.js --unregister         remove as chaves
 *   node register.js --extension-id=XXXX  define o ID autorizado
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { appDataDir } from './host';
import { REGISTRY_KEYS, buildRegFile, planRegistration, writeManifest } from './register';

function readExtensionId(): string {
  const explicit = process.argv.find((a) => a.startsWith('--extension-id='));
  if (explicit) return explicit.split('=')[1] ?? '';
  const fromEnv = process.env.MI_EXTENSION_ID;
  if (fromEnv) return fromEnv;
  const file = join(appDataDir(), 'extension-id.txt');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  return '';
}

function main(): void {
  const unregister = process.argv.includes('--unregister');
  const dataDir = appDataDir();

  if (unregister) {
    for (const key of REGISTRY_KEYS) {
      spawnSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
    }
    process.stdout.write('host nativo removido do registro (Chrome e Edge)\n');
    return;
  }

  const extensionId = readExtensionId();
  if (!extensionId) {
    process.stderr.write(
      'ID da extensão ausente: use --extension-id=... ou crie %LOCALAPPDATA%\\MarketplaceIntelligence\\extension-id.txt\n',
    );
    process.exit(2);
  }

  // O host roda a partir da pasta do instalador; o manifesto guarda o caminho absoluto.
  const hostDir = dirname(resolve(process.argv[1] ?? '.'));
  const hostPath = join(hostDir, 'native-host.cmd');
  if (!existsSync(hostPath)) {
    process.stderr.write('Launcher do host nativo ausente.\n');
    process.exit(2);
  }

  const plan = planRegistration({ appDataDir: dataDir, hostExePath: hostPath, extensionId });
  writeManifest(plan);

  const failures: string[] = [];
  for (const key of plan.registryKeys) {
    const result = spawnSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', plan.manifestPath, '/f'], {
      stdio: 'ignore',
    });
    if (result.status !== 0) failures.push(key);
  }

  if (failures.length > 0) {
    const regPath = join(dirname(plan.manifestPath), 'register.reg');
    try {
      const { writeFileSync } = require('node:fs') as typeof import('node:fs');
      writeFileSync(regPath, buildRegFile(plan), 'utf8');
    } catch {
      /* .reg é apenas um plano B */
    }
    process.stderr.write(`falha ao gravar ${failures.length} chave(s). Importe manualmente: ${regPath}\n`);
    process.exit(1);
  }

  process.stdout.write(`host nativo registrado em Chrome e Edge\nmanifesto: ${plan.manifestPath}\n`);
}

main();
