import { describe, expect, it } from 'vitest';
import { parseCsvText } from '../src/importers/tabular';
describe('importação tabular sem perda de colunas', () => {
  it('preserva colunas duplicadas mesmo quando os sufixos já existem no arquivo', () => {
    const [row] = parseCsvText('sku;sku;sku_2;sku;sku_3\nA;B;C;D;E');
    expect(row).toEqual({sku:'A',sku_4:'B',sku_2:'C',sku_5:'D',sku_3:'E'});
  });
  it('preserva zeros, campos vazios e colunas com nomes reservados', () => {
    expect(parseCsvText('valor;;coluna_2\n0;;texto')).toEqual([{valor:'0',coluna_2:'',coluna_2_2:'texto'}]);
  });
});
