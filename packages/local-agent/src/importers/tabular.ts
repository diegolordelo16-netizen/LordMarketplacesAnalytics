import { Buffer } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';

export type ImportedCell = string | number | boolean | null;
export type ImportedRow = Record<string, ImportedCell>;

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 512;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 100;
const MAX_CELL_CHARS = 32_000;

function assertRows(rows: ImportedRow[]): ImportedRow[] {
  if (rows.length > MAX_ROWS) throw new Error(`arquivo excede o limite de ${MAX_ROWS} linhas`);
  let total = 0;
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      total += key.length + String(value ?? '').length;
      if (String(value ?? '').length > MAX_CELL_CHARS) throw new Error('célula excede o limite de texto permitido');
      if (total > MAX_UNCOMPRESSED_BYTES) throw new Error('conteúdo tabular excede o limite de expansão');
    }
  }
  return rows;
}

export function parseCsvText(text: string): ImportedRow[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new Error('CSV maior que 2 MB');
  text = text.replace(/^\uFEFF/, '');
  const sample = text.split(/\r?\n/, 5).join('\n');
  const counts = [',', ';', '\t'].map((separator) => {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < sample.length; i += 1) {
      const char = sample[i];
      if (char === '"') {
        if (quoted && sample[i + 1] === '"') i += 1;
        else quoted = !quoted;
      } else if (!quoted && char === separator) count += 1;
    }
    return { separator, count };
  }).sort((a, b) => b.count - a.count);
  const separator = counts[0]?.count ? counts[0].separator : ',';
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (quoted) quoted = false;
      else if (cell.length === 0) quoted = true;
      else cell += char;
    } else if (!quoted && char === separator) {
      row.push(cell); cell = '';
      if (row.length > MAX_COLUMNS) throw new Error(`CSV excede ${MAX_COLUMNS} colunas`);
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((value) => value.trim() !== '')) matrix.push(row);
      row = [];
      if (matrix.length > MAX_ROWS + 1) throw new Error(`CSV excede o limite de ${MAX_ROWS} linhas`);
    } else {
      cell += char;
      if (cell.length > MAX_CELL_CHARS) throw new Error('célula excede o limite de texto permitido');
    }
  }
  if (quoted) throw new Error('CSV contém aspas sem fechamento');
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((value) => value.trim() !== '')) matrix.push(row);
  }
  if (matrix.length < 2) throw new Error('CSV precisa conter cabeçalho e pelo menos uma linha');
  if (matrix[0]!.length > MAX_COLUMNS) throw new Error(`CSV excede ${MAX_COLUMNS} colunas`);
  const headerWidth = matrix[0]!.length;
  if (matrix.slice(1).some((cells) => cells.length > headerWidth)) throw new Error('CSV contém linhas com mais colunas que o cabeçalho');
  const headers = matrix[0]!.map((header, index) => header.trim() || `coluna_${index + 1}`);
  const seen = new Map<string, number>();
  const uniqueHeaders = headers.map((header) => {
    const count = seen.get(header) ?? 0;
    seen.set(header, count + 1);
    return count ? `${header}_${count + 1}` : header;
  });
  const rows = matrix.slice(1).map((cells) => Object.fromEntries(uniqueHeaders.map((header, i) => [header, cells[i] ?? ''])));
  return assertRows(rows);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readZipEntries(archive: Buffer): Map<string, Buffer> {
  if (archive.length < 22 || archive.length > MAX_FILE_BYTES) throw new Error('XLSX inválido ou maior que 2 MB');
  let eocd = -1;
  const lower = Math.max(0, archive.length - 65_557);
  for (let i = archive.length - 22; i >= lower; i -= 1) {
    if (archive.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('estrutura ZIP do XLSX não encontrada');
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const entriesOnDisk = archive.readUInt16LE(eocd + 8);
  const entries = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  let offset = archive.readUInt32LE(eocd + 16);
  if (disk || centralDisk || entriesOnDisk !== entries || entries > MAX_ZIP_ENTRIES || offset + centralSize > eocd) {
    throw new Error('XLSX usa ZIP multidisco, Zip64 ou índice inválido');
  }
  const result = new Map<string, Buffer>();
  let totalUncompressed = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('diretório ZIP inválido');
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const expectedCrc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8').replace(/\\/g, '/');
    offset = nameStart + nameLength + extraLength + commentLength;
    if ((flags & 1) !== 0) throw new Error('XLSX criptografado não é suportado');
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('caminho inválido dentro do XLSX');
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('XLSX Zip64 não é suportado');
    if (!name || name.endsWith('/')) continue;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error('XLSX excede o limite de expansão de 20 MB');
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('cabeçalho ZIP local inválido');
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > archive.length) throw new Error('dados ZIP truncados');
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) });
    else throw new Error(`método de compressão XLSX não suportado: ${method}`);
    if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) throw new Error(`integridade ZIP inválida: ${name}`);
    result.set(name, data);
  }
  return result;
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, token: string) => {
    const lower = token.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return entity;
  });
}

function xmlAttribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`));
  return match ? decodeXml(match[1]!) : null;
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters) throw new Error(`referência de célula inválida: ${reference}`);
  let value = 0;
  for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1;
}

function resolveFirstSheet(entries: Map<string, Buffer>): string {
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8');
  const rels = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (!workbook || !rels) throw new Error('XLSX sem workbook ou relacionamentos');
  if (/<!DOCTYPE|<!ENTITY/i.test(workbook + rels)) throw new Error('declarações XML externas não são permitidas');
  const sheetTag = workbook.match(/<sheet\b[^>]*\br:id="([^"]+)"[^>]*\/?\s*>/i)?.[0];
  const relationId = sheetTag ? xmlAttribute(sheetTag, 'r:id') : null;
  if (!relationId) throw new Error('XLSX não contém planilha');
  const rel = [...rels.matchAll(/<Relationship\b[^>]*\/?\s*>/gi)]
    .map((match) => match[0])
    .find((tag) => xmlAttribute(tag, 'Id') === relationId);
  const target = rel ? xmlAttribute(rel, 'Target') : null;
  if (!target) throw new Error('relacionamento da primeira planilha ausente');
  const normalized = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  const path = parts.join('/');
  if (!path.startsWith('xl/worksheets/') || !entries.has(path)) throw new Error('caminho da primeira planilha inválido');
  return path;
}

export function parseXlsxBase64(base64: string): ImportedRow[] {
  if (!base64 || base64.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 16) throw new Error('XLSX vazio ou maior que 2 MB');
  const clean = base64.replace(/^data:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\+xml;base64,/i, '').replace(/\s/g, '');
  const archive = Buffer.from(clean, 'base64');
  if (archive.length > MAX_FILE_BYTES || archive.subarray(0, 2).toString('hex') !== '504b') throw new Error('arquivo não é um XLSX/ZIP válido');
  const entries = readZipEntries(archive);
  const sheetPath = resolveFirstSheet(entries);
  const sheet = entries.get(sheetPath)!.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(sheet)) throw new Error('declarações XML externas não são permitidas');
  const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const sharedStrings = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) =>
    [...match[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((item) => decodeXml(item[1]!)).join(''),
  );
  const matrix: ImportedCell[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const cells: ImportedCell[] = [];
    for (const cellMatch of rowMatch[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const tag = cellMatch[0];
      const attrs = cellMatch[1]!;
      const body = cellMatch[2]!;
      const ref = xmlAttribute(`<c ${attrs}>`, 'r');
      if (!ref) continue;
      const col = columnIndex(ref);
      if (col >= MAX_COLUMNS) throw new Error(`XLSX excede ${MAX_COLUMNS} colunas`);
      const type = xmlAttribute(`<c ${attrs}>`, 't');
      const value = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1];
      let parsed: ImportedCell = null;
      if (type === 'inlineStr') {
        parsed = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((item) => decodeXml(item[1]!)).join('');
      } else if (type === 's' && value !== undefined) {
        const index = Number(value);
        if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) throw new Error('índice de shared string inválido no XLSX');
        parsed = sharedStrings[index]!;
      } else if (type === 'b' && value !== undefined) parsed = value === '1';
      else if (value !== undefined) {
        const decoded = decodeXml(value);
        const number = Number(decoded);
        parsed = decoded !== '' && Number.isFinite(number) ? number : decoded;
      }
      cells[col] = parsed;
    }
    matrix.push(cells);
    if (matrix.length > MAX_ROWS + 1) throw new Error(`XLSX excede o limite de ${MAX_ROWS} linhas`);
  }
  if (matrix.length < 2) throw new Error('XLSX precisa conter cabeçalho e pelo menos uma linha');
  const header = matrix[0]!;
  let lastColumn = header.length - 1;
  while (lastColumn >= 0 && (header[lastColumn] === null || header[lastColumn] === undefined || String(header[lastColumn]).trim() === '')) lastColumn -= 1;
  if (lastColumn < 0) throw new Error('cabeçalho da planilha está vazio');
  if (lastColumn + 1 > MAX_COLUMNS) throw new Error(`XLSX excede ${MAX_COLUMNS} colunas`);
  const seen = new Map<string, number>();
  const headers = Array.from({ length: lastColumn + 1 }, (_, index) => {
    const value = header[index] === null || header[index] === undefined ? '' : String(header[index]).trim();
    const base = value || `coluna_${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}_${count + 1}` : base;
  });
  const rows = matrix.slice(1).map((cells) => Object.fromEntries(headers.map((name, index) => [name, cells[index] ?? null])))
    .filter((row) => Object.values(row).some((value) => value !== null && String(value).trim() !== ''));
  if (rows.length === 0) throw new Error('planilha não contém linhas de dados');
  return assertRows(rows);
}
