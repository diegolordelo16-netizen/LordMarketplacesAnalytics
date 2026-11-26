/**
 * Host de mensagens nativas (§4): ponte entre a extensão e o serviço local.
 *
 * Protocolo do Chrome/Edge: cada mensagem é um objeto JSON precedido por 4 bytes
 * little-endian com o tamanho. Limites de tamanho aplicados nos dois sentidos.
 * Regras:
 *  - Nada é escrito em stdout além das mensagens do protocolo (stdout é o canal).
 *  - Logs vão para arquivo em %LOCALAPPDATA%\MarketplaceIntelligence\logs.
 *  - Todo payload é validado com Zod antes de chegar ao serviço.
 *  - Nenhum segredo, cookie ou token é lido, guardado ou transmitido.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ipcRequestSchema, MAX_MESSAGE_BYTES } from '@mi/shared';
import type { IpcResponse } from '@mi/shared';

export const MAX_FRAME_BYTES = MAX_MESSAGE_BYTES;

export interface HostLogger {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

export function createFileLogger(dir: string, name = 'native-host.log'): HostLogger {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  const write = (level: string, message: string) => {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    try {
      appendFileSync(file, line, 'utf8');
    } catch {
      /* log nunca pode derrubar o host */
    }
  };
  return {
    info: (m) => write('INFO', m),
    error: (m, err) => write('ERROR', `${m}${err ? ` :: ${err instanceof Error ? err.stack ?? err.message : String(err)}` : ''}`),
  };
}

export interface FrameReader {
  /** Lê um frame completo; null em EOF. Lança em frame acima do limite. */
  read(): Buffer | null;
}

/** Leitor síncrono de frames (4 bytes LE + payload JSON UTF-8). */
export class BufferFrameReader implements FrameReader {
  private offset = 0;

  constructor(private readonly source: Buffer) {}

  read(): Buffer | null {
    if (this.offset + 4 > this.source.length) return null;
    const length = this.source.readUInt32LE(this.offset);
    if (length === 0) {
      this.offset += 4;
      return Buffer.alloc(0);
    }
    if (length > MAX_FRAME_BYTES) {
      throw new Error(`frame de ${length} bytes excede o limite de ${MAX_FRAME_BYTES}`);
    }
    const start = this.offset + 4;
    const end = start + length;
    if (end > this.source.length) return null;
    this.offset = end;
    return this.source.subarray(start, end);
  }
}

/** Serializa um objeto em um frame do protocolo. */
export function encodeFrame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  if (json.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`resposta de ${json.byteLength} bytes excede o limite de ${MAX_FRAME_BYTES}`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.byteLength, 0);
  return Buffer.concat([header, json]);
}

export type ServiceCall = (request: unknown) => Promise<IpcResponse>;

export interface HostOptions {
  service: ServiceCall;
  logger: HostLogger;
  /** Extensão permitida: o Chrome envia a origem como argv[1] no Windows (chrome-extension://ID/). */
  allowedExtensionId?: string;
}

export interface HostRunResult {
  responses: IpcResponse[];
  errors: string[];
}

/**
 * Processa todos os frames de uma entrada. Função pura em relação a I/O:
 * recebe bytes, devolve respostas — o que a torna testável sem navegador.
 */
export async function processFrames(input: Buffer, options: HostOptions): Promise<HostRunResult> {
  const reader = new BufferFrameReader(input);
  const responses: IpcResponse[] = [];
  const errors: string[] = [];

  for (;;) {
    let frame: Buffer | null;
    try {
      frame = reader.read();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      options.logger.error('frame rejeitado', err);
      break;
    }
    if (frame === null) break;
    if (frame.length === 0) continue;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(frame.toString('utf8'));
    } catch (err) {
      errors.push('payload não é JSON válido');
      options.logger.error('json inválido', err);
      continue;
    }

    const parsed = ipcRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const id = typeof (parsedJson as { id?: unknown })?.id === 'string' ? (parsedJson as { id: string }).id : 'unknown';
      responses.push({
        id,
        ok: false,
        protocolVersion: 1,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
      continue;
    }

    try {
      responses.push(await options.service(parsed.data));
    } catch (err) {
      responses.push({
        id: parsed.data.id,
        ok: false,
        protocolVersion: 1,
        error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
      });
      options.logger.error(`falha no método ${parsed.data.method}`, err);
    }
  }

  return { responses, errors };
}

/** Diretório de dados do app no Windows. */
export function appDataDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(base, 'MarketplaceIntelligence');
}

/**
 * Ponto de entrada real: lê stdin, responde em stdout.
 * O Chrome encerra o processo quando a extensão é desativada; nada persiste em memória.
 */
export async function runHost(options: HostOptions): Promise<void> {
  options.logger.info(`host iniciado (pid ${process.pid}, args: ${process.argv.slice(1).join(' ')})`);

  const expectedOrigin = options.allowedExtensionId ? `chrome-extension://${options.allowedExtensionId}/` : null;
  const originArg = process.argv[2];
  if (expectedOrigin && originArg && !originArg.startsWith(expectedOrigin)) {
    // Origem diferente: recusa explicitamente, sem processar nenhum frame.
    options.logger.error(`origem não autorizada: ${originArg}`);
    process.exit(1);
  }

  process.stdin.on('data', (chunk: Buffer) => {
    void (async () => {
      const result = await processFrames(chunk, options);
      for (const response of result.responses) {
        process.stdout.write(encodeFrame(response));
      }
    })();
  });

  process.stdin.on('end', () => {
    options.logger.info('stdin encerrado; host finalizando');
  });

  process.stdin.resume();
}

/** Utilitário usado pelo instalador: manifesto com o caminho absoluto do host. */
export function buildManifest(hostPath: string, extensionId: string): Record<string, unknown> {
  return {
    name: 'com.marketplaceintelligence.host',
    description: 'Marketplace Intelligence — ponte local (sem acesso a cookies/tokens)',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

/** Lê um manifesto existente, se houver (usado no diagnóstico do instalador). */
export function readManifest(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
