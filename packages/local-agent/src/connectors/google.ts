import { z } from 'zod';

export function googleReadTarget(id: string, config: unknown) {
  if (id === 'google_analytics4') {
    const data = z.object({ propertyId: z.string().regex(/^\d{1,20}$/) }).strict().parse(config);
    const name = `properties/${data.propertyId}/metadata`;
    return { provider: 'GOOGLE_ANALYTICS4', url: `https://analyticsdata.googleapis.com/v1beta/${name}`, field: 'name', expected: name };
  }
  if (id === 'google_search_console') {
    const data = z.object({ siteUrl: z.string().trim().max(500).refine((value) => {
      if (/^sc-domain:[a-z0-9.-]+\.[a-z]+$/i.test(value)) return true;
      try {
        const url = new URL(value);
        return /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
      } catch { return false; }
    }, 'informe uma propriedade HTTPS/HTTP ou sc-domain do Search Console') }).strict().parse(config);
    return { provider: 'GOOGLE_SEARCH_CONSOLE', url: `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(data.siteUrl)}`, field: 'siteUrl', expected: data.siteUrl };
  }
  return null;
}

export async function verifyGoogleRead(target: NonNullable<ReturnType<typeof googleReadTarget>>, token: string) {
  try {
    const response = await fetch(target.url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { ok: false, status: `HTTP_${response.status}`, message: `Google respondeu ${response.status}. Confira a propriedade, a permissão e o token.` };
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || (body as Record<string, unknown>)[target.field] !== target.expected) {
      return { ok: false, status: 'RESPOSTA_INESPERADA', message: 'A resposta não confirmou a propriedade.' };
    }
    return { ok: true, status: 'CONECTADO', message: 'Propriedade confirmada pela API oficial do Google.' };
  } catch {
    return { ok: false, status: 'FALHA_DE_CONEXAO', message: 'A API do Google demorou para responder ou retornou dados inválidos.' };
  }
}
