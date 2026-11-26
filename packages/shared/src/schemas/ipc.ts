/**
 * Schemas Zod de validação da ponte (IPC, Native Messaging, MAIN world).
 * Todo dado vindo do navegador é tratado como NÃO CONFIÁVEL (§4.3).
 */
import { z } from 'zod';
import { IPC_METHODS, MAX_MESSAGE_BYTES, MAX_MAIN_WORLD_MESSAGE_BYTES, PROTOCOL_VERSION } from '../types/contracts';
import { MARKETPLACE_IDS, PAGE_KINDS } from '../types/marketplace';

export const marketplaceIdSchema = z.enum(MARKETPLACE_IDS);
export const pageKindSchema = z.enum(PAGE_KINDS);

/** Identificador de mensagem: sem espaços, comprimento limitado. */
export const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export const ipcRequestSchema = z.object({
  id: idSchema,
  method: z.enum(IPC_METHODS),
  protocolVersion: z.number().int().positive(),
  token: z.string().max(4096).optional(),
  payload: z.unknown().optional(),
});

export const ipcResponseSchema = z.object({
  id: idSchema,
  ok: z.boolean(),
  protocolVersion: z.number().int().positive(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string().max(64),
      message: z.string().max(4000),
      details: z.unknown().optional(),
    })
    .optional(),
});

export function protocolCompatible(v: number): boolean {
  return v === PROTOCOL_VERSION;
}

/**
 * Valida tamanho de payload ANTES do parse. Devolve erro explícito — nunca trunca silenciosamente.
 */
export function assertPayloadSize(
  byteLength: number,
  origin: 'extension' | 'main_world' = 'extension',
): { ok: true } | { ok: false; reason: string } {
  const limit = origin === 'main_world' ? MAX_MAIN_WORLD_MESSAGE_BYTES : MAX_MESSAGE_BYTES;
  if (byteLength > limit) return { ok: false, reason: `payload ${byteLength}B > limite ${limit}B (${origin})` };
  return { ok: true };
}

/** Dados capturados da UI. Todos os números são opcionais: ausente = NOT_COLLECTED. */
export const capturedListingMetricsSchema = z.object({
  listingId: z.string().min(1).max(200),
  sku: z.string().max(200).optional(),
  title: z.string().max(2000).optional(),
  price: z.number().finite().nonnegative().optional(),
  stockAvailable: z.number().finite().nonnegative().optional(),
  visits: z.number().finite().nonnegative().optional(),
  orders: z.number().finite().nonnegative().optional(),
  units: z.number().finite().nonnegative().optional(),
  gmv: z.number().finite().nonnegative().optional(),
  organicImpressions: z.number().finite().nonnegative().optional(),
  paidImpressions: z.number().finite().nonnegative().optional(),
  adSpend: z.number().finite().nonnegative().optional(),
  adClicks: z.number().finite().nonnegative().optional(),
  adAttributedRevenue: z.number().finite().nonnegative().optional(),
  returnsCount: z.number().finite().nonnegative().optional(),
  returnsValue: z.number().finite().nonnegative().optional(),
  questionsPending: z.number().finite().nonnegative().optional(),
  reviewRating: z.number().finite().min(0).max(5).optional(),
  reviewCount: z.number().finite().nonnegative().optional(),
});

export const captureIngestSchema = z.object({
  marketplace: marketplaceIdSchema,
  accountId: z.string().min(1).max(128),
  pageKind: pageKindSchema,
  url: z.string().url().max(2048),
  /** Origem do dado: só A_PRIMARY_UI e B_PLATFORM_EXPORT são aceitos neste canal. */
  sourceClass: z.enum(['A_PRIMARY_UI', 'B_PLATFORM_EXPORT']),
  referenceAt: z.string().datetime(),
  collectedAt: z.string().datetime(),
  method: z.string().min(1).max(200),
  listings: z.array(capturedListingMetricsSchema).max(500),
  /** Evidências textuais curtas (rótulo → valor lido), para auditoria. */
  evidence: z.record(z.string().max(2000)).optional(),
});

export type CaptureIngest = z.infer<typeof captureIngestSchema>;

/** Mensagem do MAIN world: schema restritivo, sem comandos privilegiados (§4.3). */
export const mainWorldObservationSchema = z.object({
  type: z.literal('OBSERVATION'),
  url: z.string().max(2048),
  /** Nome lógico do recurso observado (ex.: `pdp_state`), nunca URL de endpoint privado. */
  resource: z.string().max(120),
  /** Somente dados já renderizados/consumidos pela página. */
  data: z.record(z.unknown()),
  observedAt: z.string().datetime(),
});

export type MainWorldObservation = z.infer<typeof mainWorldObservationSchema>;

/** Lista de comandos que o MAIN world jamais pode originar. */
export const PRIVILEGED_COMMANDS = new Set<string>([
  'gemini.setKey',
  'autoupgrade.apply',
  'autoupgrade.rollback',
  'manage_users',
  'backup.create',
  'task.runNow',
  'auth.bootstrap',
  'settings.set',
]);

export const guardEvaluationSchema = z.object({
  marketplace: marketplaceIdSchema,
  accountId: z.string().min(1),
  listingId: z.string().min(1),
  action: z.enum(['edit_title', 'edit_description', 'upload_image', 'change_price', 'duplicate_listing', 'toggle_ads']),
  expectedState: z.record(z.unknown()).optional(),
  newValues: z.record(z.unknown()).optional(),
  actorRole: z.enum(['super_admin', 'operador', 'visualizador']),
});

export type GuardEvaluationInput = z.infer<typeof guardEvaluationSchema>;
