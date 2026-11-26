/**
 * Registro do host nativo no Windows (Chrome e Edge).
 *
 * Chrome: HKCU\Software\Google\Chrome\NativeMessagingHosts\com.marketplaceintelligence.host
 * Edge:   HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.marketplaceintelligence.host
 *
 * Escreve apenas o usuário atual (HKCU): não exige administrador e é o padrão recomendado.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildManifest } from './host';

export const HOST_NAME = 'com.marketplaceintelligence.host';

export const REGISTRY_KEYS = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
] as const;

export interface RegistrationPlan {
  manifestPath: string;
  manifest: Record<string, unknown>;
  registryKeys: readonly string[];
  /** Comandos que o instalador deve executar (reg.exe), um por chave. */
  commands: string[];
  notes: string[];
}

/**
 * Monta o plano de registro. Não executa nada: o instalador é quem aplica,
 * o que mantém esta função testável e auditável.
 */
export function planRegistration(input: {
  appDataDir: string;
  hostExePath: string;
  extensionId: string;
}): RegistrationPlan {
  const manifestPath = join(input.appDataDir, 'native-host', `${HOST_NAME}.json`);
  const manifest = buildManifest(input.hostExePath, input.extensionId);
  const commands = REGISTRY_KEYS.map(
    (key) => `reg add "${key}" /ve /t REG_SZ /d "${manifestPath}" /f`,
  );
  const notes: string[] = [
    'o caminho do manifesto deve ser absoluto: o navegador não resolve caminhos relativos',
    'a extensão precisa estar carregada (ID estável) antes de registrar allowed_origins',
  ];
  if (!/^[a-p]{32}$/.test(input.extensionId)) {
    notes.push('o ID informado não tem o formato de 32 letras (a-p) usado pelo Chrome/Edge');
  }
  return { manifestPath, manifest, registryKeys: REGISTRY_KEYS, commands, notes };
}

/** Escreve o manifesto no disco. Chamado pelo instalador, não pelo host em execução. */
export function writeManifest(plan: RegistrationPlan): void {
  mkdirSync(dirname(plan.manifestPath), { recursive: true });
  writeFileSync(plan.manifestPath, JSON.stringify(plan.manifest, null, 2), 'utf8');
}

/** Script .reg equivalente, para instalação manual ou diagnóstico. */
export function buildRegFile(plan: RegistrationPlan): string {
  const lines = ['Windows Registry Editor Version 5.00', ''];
  // O valor gravado é o caminho do manifesto do host (não o do .exe): é o que
  // o Chrome/Edge leem para descobrir o executável e a origem autorizada.
  const value = plan.manifestPath.replace(/\\/g, '\\\\');
  for (const key of plan.registryKeys) {
    lines.push(`[${key.replace(/^HKCU\\/, 'HKEY_CURRENT_USER\\')}]`);
    lines.push(`@="${value}"`);
    lines.push('');
  }
  return lines.join('\r\n');
}
