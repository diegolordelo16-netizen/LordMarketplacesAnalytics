import { describe, expect, it } from 'vitest';
import { firstOccurrence, intervalFor, nextOccurrence, retryOccurrence } from '../src/scheduler/cadence';

describe('cadência de análises e relatórios', () => {
  it('aceita intervalos customizados entre 15 minutos e 30 dias', () => {
    expect(intervalFor('custom', 15)).toBe(15 * 60_000);
    expect(intervalFor('custom', 43_200)).toBe(43_200 * 60_000);
    expect(() => intervalFor('custom', 14)).toThrow(/15 e 43200/);
    expect(() => intervalFor('custom', 43_201)).toThrow(/15 e 43200/);
    expect(() => intervalFor('custom', 15.5)).toThrow(/15 e 43200/);
  });

  it('preserva a âncora e pula os períodos perdidos', () => {
    expect(nextOccurrence('2026-11-27T00:00:00.000Z', '1h', null, new Date('2026-11-27T03:20:00.000Z')))
      .toBe('2026-11-27T04:00:00.000Z');
    expect(nextOccurrence('2026-11-27T00:00:00.000Z', '1h', 30, new Date('2026-11-27T01:10:00.000Z')))
      .toBe('2026-11-27T01:30:00.000Z');
  });

  it('calcula primeira execução e backoff escalonado', () => {
    const now = new Date('2026-11-27T00:00:00.000Z');
    expect(firstOccurrence('custom', 45, now)).toBe('2026-11-27T00:45:00.000Z');
    expect(retryOccurrence(1, now)).toBe('2026-11-27T00:05:00.000Z');
    expect(retryOccurrence(2, now)).toBe('2026-11-27T00:15:00.000Z');
    expect(retryOccurrence(3, now)).toBe('2026-11-27T01:00:00.000Z');
    expect(() => retryOccurrence(4, now)).toThrow(/fora do limite/);
  });
});
