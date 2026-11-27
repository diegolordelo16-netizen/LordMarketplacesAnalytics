import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCsvText, parseXlsxBase64 } from '../src/importers/tabular';
import { parsePdfBase64 } from '../src/importers/pdf';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('importação tabular segura', () => {
  it('interpreta CSV separado por ponto e vírgula, aspas e campos multilinha', () => {
    const rows = parseCsvText('Nome;Valor\r\n"Produto; Azul";10\r\n"Linha 1\nLinha 2";"20"\r\n"Com aspas ""ok""";30');
    expect(rows).toEqual([
      { Nome: 'Produto; Azul', Valor: '10' },
      { Nome: 'Linha 1\nLinha 2', Valor: '20' },
      { Nome: 'Com aspas "ok"', Valor: '30' },
    ]);
  });

  it('diferencia cabeçalhos repetidos e não aceita CSV truncado', () => {
    expect(parseCsvText('sku,sku\nA,1')[0]).toEqual({ sku: 'A', sku_2: '1' });
    expect(() => parseCsvText('nome,valor\n"sem fechar,1')).toThrow(/aspas sem fechamento/);
  });

  it('lê XLSX ZIP comprimido, shared strings e valores numéricos/booleanos', () => {
    const bytes = readFileSync(join(testDir, 'fixtures', 'tabular-mini.xlsx'));
    const rows = parseXlsxBase64(bytes.toString('base64'));
    expect(rows).toEqual([
      { Indicador: 'revenue', Valor: 1234.5 },
      { Indicador: 'orders', Valor: true },
    ]);
  });

  it('extrai texto simples de PDF digital e sinaliza limites de leitura de tabelas', () => {
    const pdf = '%PDF-1.4\n1 0 obj << >> stream\nBT /F1 12 Tf (Relatorio de vendas) Tj 0 -14 Td [(Receita bruta) 120 (R$ 1.234,56)] TJ ET\nendstream\nendobj\n%%EOF';
    const result = parsePdfBase64(Buffer.from(pdf, 'latin1').toString('base64'));
    expect(result.text).toContain('Relatorio de vendas');
    expect(result.text).toContain('Receita bruta');
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/tabelas, colunas/)]));
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('rejeita PDF inválido e PDF sem texto extraível', () => {
    expect(() => parsePdfBase64(Buffer.from('not a pdf').toString('base64'))).toThrow(/PDF/);
    const scanned = '%PDF-1.4\n1 0 obj << /Type /Page >>\nendobj\n%%EOF';
    expect(() => parsePdfBase64(Buffer.from(scanned).toString('base64'))).toThrow(/sem texto extraível/);
  });

  it('rejeita arquivo XLSX que não seja ZIP e texto excessivo', () => {
    expect(() => parseXlsxBase64(Buffer.from('não é xlsx').toString('base64'))).toThrow(/XLSX|ZIP/);
    expect(() => parseCsvText('a,b\n' + 'x'.repeat(2 * 1024 * 1024 + 1) + ',1')).toThrow(/2 MB/);
  });
});
