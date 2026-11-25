/**
 * Cliente do canal para o dashboard em aba inteira.
 *
 * O dashboard fala com o serviço local pelo service worker da extensão (mesmo
 * caminho do painel lateral), e com a aba ativa pelo content script. Nenhuma
 * lógica de negócio mora aqui: só transporte e tipagem.
 */
import type { PageContext } from "../adapters/detect-page.js";

export interface PanelReply<T = unknown> {
  ok: boolean;
  status?: ChannelStatus;
  result?: T;
  error?: string;
}

export type ChannelStatus =
  | { state: "disconnected"; reason?: string }
  | { state: "connecting" }
  | { state: "paired"; sessionId: string; serverVersion: string }
  | { state: "error"; code: string; message: string };

export async function call<T = unknown>(message: unknown): Promise<PanelReply<T>> {
  // Sem chrome.runtime (pré-visualização do layout fora da extensão), o mesmo
  // formato de mensagem vai para um canal HTTP local só de inspeção. No
  // produto instalado este caminho nunca é usado.
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    const r = await fetch("/__preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    return (await r.json()) as PanelReply<T>;
  }
  return (await chrome.runtime.sendMessage(message)) as PanelReply<T>;
}

export async function ask<T = unknown>(
  namespace: string,
  action: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const reply = await call<T>({ kind: "channel.request", namespace, payload: { action, ...extra } });
  if (!reply.ok) throw new Error(reply.error ?? "falha no canal");
  // Alguns handlers já devolvem o envelope completo ({ ok, result }); aqui se
  // desembrulha para o painel nunca receber um objeto aninhado por engano.
  const raw = reply.result as unknown;
  if (raw && typeof raw === "object" && "ok" in (raw as Record<string, unknown>) && "result" in (raw as Record<string, unknown>)) {
    const inner = raw as { ok: boolean; result?: T; error?: string };
    if (!inner.ok) throw new Error(inner.error ?? "falha no canal");
    return inner.result as T;
  }
  return reply.result as T;
}

export interface MetricSummary {
  metric: string;
  latest: number | null;
  latestQuality: string | null;
  latestAt: string | null;
  changePct: number | null;
  insufficientHistory: boolean;
}

export interface ListingRow {
  entityRef: string;
  title: string | null;
  priceCents: number | null;
  stock: number | null;
  metrics: MetricSummary[];
}

export interface AlertRow {
  id: string;
  severity: "info" | "attention" | "critical";
  title: string;
  detail: string;
  evidence: string;
  entityRef: string | null;
}

export interface ListingsReply {
  listings: ListingRow[];
  qualityCensus: Record<string, number>;
  alerts: AlertRow[];
}

export interface RecommendationRow {
  id: string;
  priority: number;
  area: string;
  title: string;
  rationale: string;
  actions: string[];
  evidence: string[];
  confidence: "alta" | "media" | "baixa";
}

export interface BrainReport {
  generatedAt: string;
  listingsAnalyzed: number;
  recommendations: RecommendationRow[];
  blindSpots: string[];
  dataCompleteness?: { metric: string; complete: boolean; note: string }[];
}

export interface ImprovementRow {
  id: string;
  title: string;
  rationale: string;
  kind: string;
  status: string;
  createdAt: string;
  decisionNote: string | null;
}

export interface CaptureReply {
  runId: string;
  outcome: string;
  cardsSeen?: number;
  cardsParsed?: number;
  rowsSeen?: number;
  rowsParsed?: number;
  rowsWithoutId?: number;
  observationsWritten: number;
  note?: string;
}

export interface SalesStock {
  ordersCaptured: number;
  ordersWithValue: number;
  totalCents: number;
  byMarketplace: Record<string, { orders: number; totalCents: number }>;
  stockKnown: number;
  note?: string;
}

export interface HealthReply {
  ok: boolean;
  version: string;
  migrations: string[];
  audit: { ok: boolean; brokenAtSeq: number | null; total: number };
  gemini: { configured: boolean; remaining?: number };
  uptimeSeconds?: number;
}

export interface CredentialRow {
  id: string;
  marketplace: string;
  accountRef: string | null;
  label: string;
  publicFields: Record<string, string>;
  scopes: string[];
  status: "ACTIVE" | "INVALID" | "REVOKED";
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  lastError: string | null;
  hasSecret: boolean;
}

export interface ConnectorField {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  hint: string;
}

export interface ConnectorSpec {
  marketplace: string;
  name: string;
  howTo: string;
  authType: string;
  docsUrl: string;
  fields: ConnectorField[];
}

export interface ApiCatalog {
  connectors: ConnectorSpec[];
  encryptionAvailable: boolean;
  note: string;
}

const hasChrome = (): boolean => typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);

export async function channelStatus(): Promise<ChannelStatus | null> {
  const r = await call<ChannelStatus>({ kind: "channel.status" });
  return r.ok && r.status ? r.status : null;
}

export async function connectChannel(url: string, token: string): Promise<PanelReply<ChannelStatus>> {
  return call<ChannelStatus>({ kind: "channel.connect", url, token });
}

export async function readStored(): Promise<{ lmaToken?: string; lmaUrl?: string; lmaRecordings?: number }> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return {};
  return (await chrome.storage.local.get(["lmaToken", "lmaUrl", "lmaRecordings"])) as {
    lmaToken?: string;
    lmaUrl?: string;
    lmaRecordings?: number;
  };
}

export async function saveStored(values: Record<string, unknown>): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  await chrome.storage.local.set(values);
}

/** HTML da aba ativa (a página que o usuário tem aberta). */
export async function grabActiveTabHtml(): Promise<{ html: string; url: string; error?: undefined } | { error: string }> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) {
    return { error: "esta ação só funciona com o dashboard aberto dentro da extensão" };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { error: "nenhuma aba ativa" };
  try {
    const page = (await chrome.tabs.sendMessage(tab.id, { kind: "capture.html" })) as {
      ok?: boolean;
      html?: string;
      error?: string;
    };
    if (!page?.ok || !page.html) return { error: page?.error ?? "a aba ativa não é uma página de marketplace reconhecida" };
    return { html: page.html, url: tab.url ?? "" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function currentContext(): Promise<PageContext | null> {
  if (!hasChrome() || !chrome.tabs?.query) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    const reply = (await chrome.tabs.sendMessage(tab.id, { kind: "context.get" })) as {
      ok?: boolean;
      context?: PageContext;
    };
    return reply?.ok && reply.context ? reply.context : null;
  } catch {
    return null;
  }
}

export async function grabHtml(): Promise<{ html: string; context: PageContext } | { error: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { error: "nenhuma aba ativa" };
  try {
    const page = (await chrome.tabs.sendMessage(tab.id, { kind: "capture.html" })) as {
      ok?: boolean;
      html?: string;
      context?: PageContext;
      error?: string;
    };
    if (!page?.ok || !page.html || !page.context) {
      return { error: page?.error ?? "a aba atual não é uma página de marketplace reconhecida" };
    }
    return { html: page.html, context: page.context };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}


/** Resposta consolidada do serviço: uma chamada pinta a visão geral toda. */
export interface OverviewReply {
  totals: {
    listings: number;
    withPrice: number;
    stockUnits: number;
    competitors: number;
    missions: number;
    marginKnown: number;
    marginAvgBp: number | null;
  };
  revenueSeries: { day: string; cents: number }[];
  quality: Record<string, number>;
  marketplaces: Record<string, number>;
  missions: unknown[];
  competitors: unknown[];
  alerts: AlertRow[];
}

/**
 * Avisa o serviço local qual é o ID desta extensão.
 *
 * O instalador calcula o ID a partir da pasta de instalação; se o usuário
 * carrega a extensão de outro jeito, o ID muda e o botão da página do serviço
 * aponta para um endereço que não existe ("invalid está bloqueado"). Aqui o
 * próprio navegador informa o ID verdadeiro, sem o usuário copiar nada.
 */
export async function registrarExtensao(url: string): Promise<boolean> {
  const id = typeof chrome !== "undefined" && chrome.runtime?.id ? chrome.runtime.id : null;
  if (!id) return false;
  const base = url.replace(/^ws/, "http").replace(/\/?$/, "");
  try {
    const r = await fetch(`${base}/reparar-extensao`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
