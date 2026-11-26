/**
 * @mi/shared — tipos, schemas, contratos e motores de cálculo puros.
 *
 * Regra: nada aqui acessa rede, disco ou navegador. Tudo é determinístico e testável.
 */
export * from './types/data-quality';
export * from './types/marketplace';
export * from './types/kpi';
export * from './types/contracts';
export * from './schemas/ipc';
export * from './math/money';
export * from './math/safe';
export * from './math/stats';
export * from './kpi/engine';
export * from './finance/finance';
export * from './priority/priority';
export * from './data-intelligence/quality';
export * from './experiments/design';
export * from './keywords/scoring';
export * from './text/preservation';
export * from './security/untrusted';
export * from './competitive/similarity';
