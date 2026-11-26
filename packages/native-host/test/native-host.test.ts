import { describe, expect, it } from 'vitest';
import {
  BufferFrameReader,
  MAX_FRAME_BYTES,
  StreamingFrameDecoder,
  buildRegFile,
  encodeFrame,
  planRegistration,
  processFrames,
  processNativeStream,
  type HostLogger,
} from '../src/index';

const silentLogger: HostLogger = { info: () => {}, error: () => {} };

function frame(value: unknown): Buffer {
  return encodeFrame(value);
}

const request = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  protocolVersion: 1,
  method: 'ping',
  payload: {},
  ...over,
});

describe('framing do host nativo', () => {
  it('codifica o tamanho em 4 bytes little-endian', () => {
    const buf = encodeFrame({ a: 1 });
    expect(buf.readUInt32LE(0)).toBe(buf.length - 4);
    expect(JSON.parse(buf.subarray(4).toString('utf8'))).toEqual({ a: 1 });
  });

  it('lê frames consecutivos', () => {
    const buf = Buffer.concat([frame({ n: 1 }), frame({ n: 2 })]);
    const reader = new BufferFrameReader(buf);
    expect(JSON.parse(reader.read()!.toString('utf8'))).toEqual({ n: 1 });
    expect(JSON.parse(reader.read()!.toString('utf8'))).toEqual({ n: 2 });
    expect(reader.read()).toBeNull();
  });

  it('devolve null quando o frame está incompleto', () => {
    const buf = frame({ n: 1 }).subarray(0, 6);
    expect(new BufferFrameReader(buf).read()).toBeNull();
  });

  it('reconstitui frames quando cabeçalho e corpo chegam fragmentados', () => {
    const input = Buffer.concat([frame({ id: 'a' }), frame({ id: 'b' })]);
    const decoder = new StreamingFrameDecoder();
    const frames: Buffer[] = [];
    for (const byte of input) frames.push(...decoder.push(Buffer.from([byte])));
    decoder.finish();
    expect(frames.map((part) => JSON.parse(part.subarray(4).toString('utf8')))).toEqual([
      { id: 'a' },
      { id: 'b' },
    ]);
  });

  it('não aceita EOF com frame parcialmente recebido', () => {
    const decoder = new StreamingFrameDecoder();
    decoder.push(frame({ id: 'partial' }).subarray(0, 6));
    expect(() => decoder.finish()).toThrow(/frame incompleto/);
  });

  it('rejeita frame acima do limite', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
    expect(() => new BufferFrameReader(header).read()).toThrow(/limite/);
  });

  it('recusa codificar resposta acima do limite', () => {
    const huge = { data: 'x'.repeat(MAX_FRAME_BYTES + 10) };
    expect(() => encodeFrame(huge)).toThrow(/limite/);
  });
});

describe('processamento de mensagens', () => {
  it('encaminha pedido válido ao serviço', async () => {
    const seen: unknown[] = [];
    const result = await processFrames(frame(request()), {
      logger: silentLogger,
      service: async (req) => {
        seen.push(req);
        return { id: 'r1', ok: true, protocolVersion: 1, result: { pong: true } };
      },
    });
    expect(seen).toHaveLength(1);
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0]!.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejeita JSON inválido sem derrubar o host', async () => {
    const bad = Buffer.from('não é json');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bad.length, 0);
    const result = await processFrames(Buffer.concat([header, bad]), {
      logger: silentLogger,
      service: async () => ({ id: 'x', ok: true, protocolVersion: 1 }),
    });
    expect(result.responses).toHaveLength(0);
    expect(result.errors.join(' ')).toMatch(/JSON/);
  });

  it('rejeita pedido fora do schema com VALIDATION_ERROR', async () => {
    const result = await processFrames(frame({ id: 'r2', protocolVersion: 1, method: 'x' }), {
      logger: silentLogger,
      service: async () => {
        throw new Error('não deveria ser chamado');
      },
    });
    expect(result.responses[0]!.ok).toBe(false);
    expect(result.responses[0]!.error?.code).toBe('VALIDATION_ERROR');
  });

  it('transforma exceção do serviço em erro INTERNAL', async () => {
    const result = await processFrames(frame(request()), {
      logger: silentLogger,
      service: async () => {
        throw new Error('falha simulada');
      },
    });
    expect(result.responses[0]!.error?.code).toBe('INTERNAL');
    expect(result.responses[0]!.error?.message).toContain('falha simulada');
  });

  it('processa múltiplos pedidos na mesma entrada', async () => {
    const input = Buffer.concat([frame(request({ id: 'a' })), frame(request({ id: 'b' }))]);
    const result = await processFrames(input, {
      logger: silentLogger,
      service: async (req) => ({ id: (req as { id: string }).id, ok: true, protocolVersion: 1 }),
    });
    expect(result.responses.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('processa stream fragmentado em ordem e rejeita protocolo incompatível', async () => {
    const input = Buffer.concat([frame(request({ id: 'a' })), frame(request({ id: 'b' }))]);
    const order: string[] = [];
    const responses: Array<{ id: string }> = [];
    async function* chunks(): AsyncGenerator<Buffer> {
      yield input.subarray(0, 2);
      yield input.subarray(2, 9);
      yield input.subarray(9);
    }
    await processNativeStream(chunks(), {
      logger: silentLogger,
      service: async (raw) => {
        const id = (raw as { id: string }).id;
        order.push(`start:${id}`);
        await Promise.resolve();
        order.push(`end:${id}`);
        return { id, ok: true, protocolVersion: 1 };
      },
    }, (response) => responses.push({ id: response.id }));
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
    expect(responses.map((response) => response.id)).toEqual(['a', 'b']);

    let called = false;
    const incompatible = await processFrames(frame(request({ protocolVersion: 2 })), {
      logger: silentLogger,
      service: async () => { called = true; return { id: 'x', ok: true, protocolVersion: 1 }; },
    });
    expect(called).toBe(false);
    expect(incompatible.responses[0]?.error?.code).toBe('PROTOCOL_MISMATCH');
  });
});

describe('registro no Windows', () => {
  const plan = planRegistration({
    appDataDir: 'C:\\Users\\teste\\AppData\\Local\\MarketplaceIntelligence',
    hostExePath: 'C:\\Program Files\\MarketplaceIntelligence\\native-host.exe',
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
  });

  it('aponta para Chrome e Edge no HKCU', () => {
    expect(plan.registryKeys).toHaveLength(2);
    expect(plan.registryKeys[0]).toContain('Google\\Chrome');
    expect(plan.registryKeys[1]).toContain('Microsoft\\Edge');
    expect(plan.commands.every((c) => c.startsWith('reg add "HKCU\\'))).toBe(true);
  });

  it('usa caminho absoluto no manifesto', () => {
    expect(plan.manifestPath).toMatch(/^[A-Z]:\\/);
    expect(plan.manifest['path']).toBe('C:\\Program Files\\MarketplaceIntelligence\\native-host.exe');
    expect(plan.manifest['type']).toBe('stdio');
    expect((plan.manifest['allowed_origins'] as string[])[0]).toBe('chrome-extension://abcdefghijklmnopabcdefghijklmnop/');
  });

  it('avisa quando o ID da extensão é inválido', () => {
    const bad = planRegistration({ appDataDir: 'C:\\x', hostExePath: 'C:\\y.exe', extensionId: 'invalido' });
    expect(bad.notes.join(' ')).toMatch(/formato/);
  });

  it('gera .reg equivalente ao reg add', () => {
    const reg = buildRegFile(plan);
    expect(reg).toContain('Windows Registry Editor Version 5.00');
    expect(reg).toContain('HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts');
    // o valor gravado é o caminho do manifesto, com barras duplicadas como no formato .reg
    expect(reg).toContain('com.marketplaceintelligence.host.json');
    expect(reg).toContain('MarketplaceIntelligence\\\\native-host');
  });
});
