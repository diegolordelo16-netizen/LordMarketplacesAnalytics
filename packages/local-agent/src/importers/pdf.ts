import { Buffer } from 'node:buffer';
import { inflateSync, inflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 30 * 1024 * 1024;
const MAX_LINES = 10_000;

function decodeBytes(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const chars: number[] = [];
    for (let i = 2; i + 1 < bytes.length; i += 2) chars.push((bytes[i]! << 8) | bytes[i + 1]!);
    return String.fromCharCode(...chars);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return bytes.toString('latin1'); }
}

function decodeAscii85(input: Buffer, remaining: number): Buffer {
  const text = input.toString('latin1').replace(/[\x00\t\n\f\r ]/g, '');
  const data = text.startsWith('<~') ? text.slice(2) : text;
  if (!data.endsWith('~>')) throw new Error('ASCII85 sem terminador');
  const body = data.slice(0, -2);
  const output = Buffer.alloc(Math.min(body.length * 4, remaining));
  let offset = 0, value = 0, count = 0;
  const flush = (bytes: number) => {
    if (value > 0xffffffff) throw new Error('ASCII85 fora do intervalo');
    if (offset + bytes > output.length) throw new Error('PDF excede o limite de expansão de 30 MB');
    for (let i = 0; i < bytes; i += 1) output[offset++] = (value >>> (24 - i * 8)) & 0xff;
    value = 0; count = 0;
  };
  for (const ch of body) {
    if (ch === 'z') {
      if (count !== 0) throw new Error('ASCII85 inválido');
      flush(4); continue;
    }
    const digit = ch.charCodeAt(0) - 33;
    if (digit < 0 || digit > 84) throw new Error('ASCII85 inválido');
    value = value * 85 + digit;
    if (++count === 5) flush(4);
  }
  if (count === 1) throw new Error('ASCII85 truncado');
  if (count > 1) {
    const bytes = count - 1;
    while (count++ < 5) value = value * 85 + 84;
    flush(bytes);
  }
  return output.subarray(0, offset);
}

function decodePdfStream(dictionary: string, stream: Buffer, remaining: number): Buffer | null {
  const filter = /\/Filter\b\s*(\[[^\]]*\]|\/[A-Za-z0-9]+\b)/.exec(dictionary);
  if (!filter) return /\/Filter\b/.test(dictionary) ? null : stream;
  const names = filter[1]!.match(/\/[A-Za-z0-9]+/g) ?? [];
  if (!names.length || names.length > 2 || names.some((name) => !['/ASCII85Decode', '/A85', '/FlateDecode', '/Fl'].includes(name))) return null;
  let decoded = stream;
  for (const name of names) {
    if (remaining <= 0) throw new Error('PDF excede o limite de expansão de 30 MB');
    if (name === '/ASCII85Decode' || name === '/A85') {
      try { decoded = decodeAscii85(decoded, remaining); } catch { return null; }
    } else {
      let inflated: Buffer | null = null;
      for (const inflate of [inflateSync, inflateRawSync]) {
        try { inflated = inflate(decoded, { maxOutputLength: remaining }); break; }
        catch { /* tenta o modo zlib/raw seguinte */ }
      }
      if (!inflated) return null;
      decoded = inflated;
    }
    if (decoded.length > remaining) throw new Error('PDF excede o limite de expansão de 30 MB');
  }
  return decoded;
}

function decodeLiteral(raw: string): string {
  const out: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (ch !== '\\') { out.push(raw.charCodeAt(i) & 0xff); continue; }
    const next = raw[++i];
    if (next === undefined) break;
    const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    if (simple[next] !== undefined) { out.push(simple[next]!); continue; }
    if (next === '\n') continue;
    if (next === '\r') { if (raw[i + 1] === '\n') i += 1; continue; }
    if (/[0-7]/.test(next)) {
      let octal = next;
      for (let n = 0; n < 2 && /[0-7]/.test(raw[i + 1] ?? ''); n += 1) octal += raw[++i];
      out.push(Number.parseInt(octal, 8) & 0xff);
      continue;
    }
    out.push(next.charCodeAt(0) & 0xff);
  }
  return decodeBytes(Buffer.from(out));
}

function extractLiteralTokens(text: string): string[] {
  const out: string[] = [];
  const pushLiteralAt = (source: string, start: number): { value: string; end: number } | null => {
    if (source[start] !== '(') return null;
    let depth = 1;
    let raw = '';
    for (let i = start + 1; i < source.length; i += 1) {
      const ch = source[i]!;
      if (ch === '\\') { raw += ch + (source[i + 1] ?? ''); i += 1; continue; }
      if (ch === '(') depth += 1;
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) return { value: decodeLiteral(raw), end: i + 1 };
      }
      raw += ch;
    }
    return null;
  };
  const blocks = text.match(/\bBT\b[\s\S]*?\bET\b/g) ?? [];
  for (const block of blocks) {
    for (let i = 0; i < block.length; i += 1) {
      if (block[i] === '[') {
        const end = block.indexOf(']', i + 1);
        if (end < 0) continue;
        let tail = end + 1; while (/\s/.test(block[tail] ?? '')) tail += 1;
        if (block.slice(tail, tail + 2) === 'TJ') {
          let combined = '';
          for (let cursor = i + 1; cursor < end; cursor += 1) {
            if (block[cursor] === '(') {
              const token = pushLiteralAt(block, cursor);
              if (token && token.end <= end) { combined += token.value; cursor = token.end - 1; }
            } else if (block[cursor] === '<' && block[cursor + 1] !== '<') {
              const hexEnd = block.indexOf('>', cursor + 1);
              if (hexEnd > cursor && hexEnd < end) {
                const hex = block.slice(cursor + 1, hexEnd).replace(/\s/g, '');
                if (hex.length && hex.length % 2 === 0 && /^[a-f0-9]+$/i.test(hex)) combined += decodeBytes(Buffer.from(hex, 'hex'));
                cursor = hexEnd;
              }
            }
          }
          if (combined) out.push(combined);
        }
        i = end;
      } else if (block[i] === '(') {
        const token = pushLiteralAt(block, i);
        if (!token) continue;
        let tail = token.end;
        while (/\s/.test(block[tail] ?? '')) tail += 1;
        if (block.slice(tail, tail + 2) === 'Tj' || block.slice(tail, tail + 2) === 'TJ') out.push(token.value);
        i = token.end - 1;
      } else if (block[i] === '<' && block[i + 1] !== '<') {
        const end = block.indexOf('>', i + 1);
        if (end < 0) continue;
        const hex = block.slice(i + 1, end).replace(/\s/g, '');
        if (hex.length > 0 && hex.length % 2 === 0 && /^[a-f0-9]+$/i.test(hex)) {
          let tail = end + 1; while (/\s/.test(block[tail] ?? '')) tail += 1;
          if (block.slice(tail, tail + 2) === 'Tj') out.push(decodeBytes(Buffer.from(hex, 'hex')));
        }
        i = end;
      }
    }
  }
  return out;
}

/**
 * Usa Poppler quando instalado para interpretar ToUnicode/CMaps, compressão e
 * posicionamento textual com maior fidelidade. A execução é sem shell, recebe
 * bytes por stdin e tem limite de tempo/memória. Se não estiver disponível,
 * o parser conservador embutido continua como fallback portátil.
 */
function extractWithPoppler(bytes: Buffer): { text: string; warnings: string[] } | null {
  const executable = 'pdftotext';
  try {
    const result = spawnSync(executable, ['-layout', '-enc', 'UTF-8', '-', '-'], {
      input: bytes,
      encoding: 'buffer',
      timeout: 7_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) return null;
    const text = result.stdout.toString('utf8')
      .replace(/^\uFEFF/, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, MAX_LINES)
      .join('\n');
    if (!text) return null;
    return { text, warnings: ['texto extraído com Poppler/pdftotext; confira manualmente tabelas, colunas, totais e vínculos de origem', 'PDF digitalizado continua sem OCR; páginas sem camada de texto não são interpretadas'] };
  } catch {
    return null;
  }
}

/**
 * Extrator conservador de texto de PDF digital. Não executa JavaScript PDF,
 * não interpreta anexos e não faz OCR de páginas digitalizadas. Alguns PDFs
 * usam fontes com ToUnicode/CMaps proprietários e podem produzir texto parcial.
 */
export function parsePdfBase64(base64: string): { rows: Array<{ line: string }>; text: string; warnings: string[] } {
  if (!base64 || base64.length > Math.ceil(MAX_PDF_BYTES * 4 / 3) + 32) throw new Error('PDF vazio ou acima de 5 MB');
  const clean = base64.replace(/^data:application\/pdf;base64,/i, '').replace(/\s/g, '');
  const bytes = Buffer.from(clean, 'base64');
  if (bytes.length < 8 || bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('arquivo PDF inválido ou maior que 5 MB');
  const poppler = extractWithPoppler(bytes);
  if (poppler?.text) {
    const lines = poppler.text.split('\n').slice(0, MAX_LINES);
    return { rows: lines.map((line) => ({ line })), text: lines.join('\n'), warnings: poppler.warnings };
  }
  const source = bytes.toString('latin1');
  const chunks: Buffer[] = [];
  let expanded = 0;
  // Delimita o cabeçalho de cada objeto, inclusive dicionários multilinha.
  // Usa /Length direto quando presente; o delimitador é apenas fallback.
  const streamPattern = /\b\d+\s+\d+\s+obj\s*<<((?:(?!\bendobj\b)[\s\S])*?)>>\s*stream(?:\r\n|\n|\r)/g;
  for (let match = streamPattern.exec(source); match; match = streamPattern.exec(source)) {
    const dictionary = match[1] ?? '';
    const start = streamPattern.lastIndex;
    const lengthMatch = /\/Length\s+(\d+)\b(?!\s+\d+\s+R\b)/.exec(dictionary);
    const length = lengthMatch ? Number(lengthMatch[1]) : null;
    let end: number;
    if (length !== null) {
      if (!Number.isSafeInteger(length) || length < 0 || start + length > source.length) continue;
      end = start + length;
      const marker = /^(?:\r\n|\r|\n)?endstream\b/.exec(source.slice(end, end + 16));
      if (!marker) continue;
      streamPattern.lastIndex = end + marker[0].length;
    } else {
      const marker = /(?:\r\n|\r|\n)endstream\b/g;
      marker.lastIndex = start;
      const found = marker.exec(source);
      if (!found) continue;
      end = found.index;
      streamPattern.lastIndex = marker.lastIndex;
    }
    const decoded = decodePdfStream(dictionary, bytes.subarray(start, end), MAX_EXPANDED_BYTES - expanded);
    if (!decoded) continue;
    expanded += decoded.length;
    if (expanded > MAX_EXPANDED_BYTES) throw new Error('PDF excede o limite de expansão de 30 MB');
    chunks.push(decoded);
  }
  if (!chunks.length) {
    // PDFs mínimos ou sem streams podem ter operadores textuais fora de stream.
    chunks.push(bytes);
  }
  const extracted = chunks.flatMap((chunk) => extractLiteralTokens(chunk.toString('latin1')));
  const text = extracted.join('\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, MAX_LINES).join('\n');
  if (!text.trim()) throw new Error('PDF sem texto extraível; arquivos digitalizados/OCR e fontes CMap não suportadas nesta importação');
  const lines = text.split('\n').slice(0, MAX_LINES);
  return {
    rows: lines.map((line) => ({ line })),
    text,
    warnings: ['extração conservadora embutida para staging; tabelas, colunas e totais precisam de conferência manual', 'Poppler/pdftotext indisponível; PDF digitalizado/OCR e fontes CMap não são suportados no fallback embutido'],
  };
}
