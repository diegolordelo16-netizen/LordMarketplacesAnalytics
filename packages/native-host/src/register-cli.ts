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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { appDataDir } from './host';
import { HOST_NAME, buildRegFile, planRegistration, writeManifest } from './register';

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
    for (const key of [
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
      `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
    ]) {
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

  if (!/^[a-p]{32}$/.test(extensionId)) {
    process.stderr.write('ID da extensão inválido: esperado 32 letras de a a p\n');
    process.exit(2);
  }

  // Chromium interpreta path como caminho de arquivo, não uma linha de comando.
  const hostDir = dirname(resolve(process.argv[1] ?? '.'));
  const hostPath = join(hostDir, 'native-host.bat');
  const nodeExe = join(dirname(hostDir), 'node.exe');
  if (!existsSync(hostPath) || !existsSync(nodeExe) || !existsSync(join(hostDir, 'native-host.js'))) {
    process.stderr.write('Host nativo ou runtime ausente: reinstale o pacote Windows completo\n');
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
