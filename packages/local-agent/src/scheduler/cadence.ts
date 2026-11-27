/** Utilitários determinísticos para recorrência e retentativa de agendamentos. */
export const FIXED_CADENCE_MS = {
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
} as const;

export type FixedCadence = keyof typeof FIXED_CADENCE_MS;
export type ScheduleCadence = FixedCadence | 'custom';

export function intervalFor(cadence: ScheduleCadence, intervalMinutes?: number | null): number {
  if (cadence === 'custom' || intervalMinutes !== undefined && intervalMinutes !== null) {
    if (!Number.isInteger(intervalMinutes) || Number(intervalMinutes) < 15 || Number(intervalMinutes) > 43_200) {
      throw new Error('intervalo personalizado deve ser um número inteiro entre 15 e 43200 minutos');
    }
    return Number(intervalMinutes) * 60_000;
  }
  return FIXED_CADENCE_MS[cadence];
}

export function firstOccurrence(
  cadence: ScheduleCadence,
  intervalMinutes?: number | null,
  from: Date = new Date(),
): string {
  const interval = intervalFor(cadence, intervalMinutes);
  return new Date(from.getTime() + interval).toISOString();
}

/**
 * Avança a partir do horário programado original sem acumular drift.
 * Quando o serviço ficou desligado por vários ciclos, salta para a próxima
 * ocorrência futura em vez de executar dezenas de vezes em sequência.
 */
export function nextOccurrence(
  previousAt: string,
  cadence: ScheduleCadence,
  intervalMinutes?: number | null,
  now: Date = new Date(),
): string {
  const interval = intervalFor(cadence, intervalMinutes);
  const previous = Date.parse(previousAt);
  if (!Number.isFinite(previous)) throw new Error('next_run_at anterior inválido');
  let next = previous + interval;
  if (next <= now.getTime()) {
    const skipped = Math.floor((now.getTime() - next) / interval) + 1;
    next += skipped * interval;
  }
  return new Date(next).toISOString();
}

const RETRY_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

export function retryOccurrence(failureCount: number, now: Date = new Date()): string {
  if (!Number.isInteger(failureCount) || failureCount < 1 || failureCount > RETRY_BACKOFF_MS.length) {
    throw new Error('número de falhas fora do limite de retentativas');
  }
  return new Date(now.getTime() + RETRY_BACKOFF_MS[failureCount - 1]!).toISOString();
}


export interface RetryDecision {
  consecutiveFailures: number;
  shouldRetry: boolean;
  nextRunAt: string | null;
}

/** failureCount é o número de falhas anteriores já persistidas. Permite até 3 retentativas após a tentativa inicial. */
export function retryDecision(failureCount: number, now: Date = new Date()): RetryDecision {
  if (!Number.isInteger(failureCount) || failureCount < 0 || failureCount > RETRY_BACKOFF_MS.length) {
    throw new Error('número de falhas fora do limite de retentativas');
  }
  if (failureCount === RETRY_BACKOFF_MS.length) {
    return { consecutiveFailures: failureCount, shouldRetry: false, nextRunAt: null };
  }
  const consecutiveFailures = failureCount + 1;
  return {
    consecutiveFailures,
    shouldRetry: true,
    nextRunAt: retryOccurrence(consecutiveFailures, now),
  };
}
