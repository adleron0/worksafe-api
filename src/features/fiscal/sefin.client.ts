import axios, { AxiosInstance } from 'axios';
import { Agent } from 'https';
import { gunzipSync, gzipSync } from 'zlib';
import type { LoadedCertificate } from './certificate';

/**
 * Cliente da API do Emissor Público Nacional (Sefin Nacional).
 *
 * Autenticação por mTLS com o certificado A1 da empresa (sem login nem token).
 * Os documentos vão em XML assinado, compactado em GZip e codificado em Base64
 * dentro de um JSON. Os nomes dos campos de resposta variam em maiúsculas entre
 * versões, então a leitura aceita as duas grafias.
 *
 * As URLs podem ser trocadas pelas variáveis FISCAL_SEFIN_URL e
 * FISCAL_SEFIN_URL_RESTRITA (a documentação oficial e os SDKs divergem no
 * caminho da produção restrita: com ou sem "/API").
 */

export type SefinEnvironment = 'restrita' | 'producao';

export const SEFIN_URLS: Record<SefinEnvironment, string> = {
  producao: 'https://sefin.nfse.gov.br/SefinNacional',
  restrita: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
};

export function sefinBaseUrl(environment: SefinEnvironment): string {
  const custom = environment === 'producao' ? process.env.FISCAL_SEFIN_URL : process.env.FISCAL_SEFIN_URL_RESTRITA;
  return (custom || SEFIN_URLS[environment]).replace(/\/+$/, '');
}

export interface SefinMessage { code: string; description: string; complement?: string }

export interface SefinResult {
  ok: boolean;
  status: number;
  accessKey?: string;
  xml?: string; // XML devolvido (NFS-e ou evento), já descompactado
  errors: SefinMessage[];
  alerts: SefinMessage[];
  raw?: unknown;
}

/** Falha de transporte: sem resposta (queda, timeout, TLS). A nota pode ou não ter sido gerada. */
export class SefinTransportError extends Error {
  constructor(message: string, readonly causeCode?: string) { super(message); }
}

export const packXml = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
export const unpackXml = (b64: string) => gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');

const pick = (obj: Record<string, unknown> | undefined, ...names: string[]): unknown => {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const name of names) {
    const key = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key !== undefined && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
};

function messagesOf(value: unknown): SefinMessage[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((item) => {
      if (typeof item === 'string') return { code: '', description: item };
      const row = item as Record<string, unknown>;
      return {
        code: String(pick(row, 'codigo', 'code') ?? ''),
        description: String(pick(row, 'descricao', 'mensagem', 'message', 'description') ?? ''),
        complement: pick(row, 'complemento', 'detail') ? String(pick(row, 'complemento', 'detail')) : undefined,
      };
    })
    .filter((m) => m.code || m.description);
}

/** Lê uma resposta da Sefin (sucesso ou rejeição) no formato comum. */
export function parseSefinResponse(status: number, data: unknown): SefinResult {
  const body = (typeof data === 'string' ? safeJson(data) : data) as Record<string, unknown> | undefined;
  const errors = messagesOf(pick(body, 'erros', 'erro'));
  const alerts = messagesOf(pick(body, 'alertas', 'alerta'));
  let xml: string | undefined;
  if (body && typeof body === 'object') {
    const key = Object.keys(body).find((k) => /XmlGZipB64$/i.test(k) && typeof body[k] === 'string');
    if (key) xml = unpackXml(String(body[key]));
  }
  const accessKey = pick(body, 'chaveAcesso') ? String(pick(body, 'chaveAcesso')) : undefined;
  const ok = status >= 200 && status < 300 && errors.length === 0;
  if (!ok && !errors.length) {
    errors.push({ code: String(status), description: typeof data === 'string' && /<html/i.test(data) ? 'O ambiente nacional recusou a conexão (confira o certificado digital).' : `Resposta inesperada do ambiente nacional (HTTP ${status}).` });
  }
  return { ok, status, accessKey, xml, errors, alerts, raw: body };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

export class SefinClient {
  private readonly http: AxiosInstance;

  constructor(environment: SefinEnvironment, certificate: Pick<LoadedCertificate, 'privateKeyPem' | 'certificatePem'>, timeoutMs = 60_000) {
    // chave e certificado em PEM (e não o .pfx direto): pfx antigo com cifra legada
    // não abre no OpenSSL 3 do Node
    const httpsAgent = new Agent({ key: certificate.privateKeyPem, cert: certificate.certificatePem, keepAlive: false });
    this.http = axios.create({
      baseURL: sefinBaseUrl(environment),
      httpsAgent,
      timeout: timeoutMs,
      validateStatus: () => true,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      transformResponse: [(data) => data],
    });
  }

  private async request(method: 'GET' | 'POST' | 'HEAD', path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    try {
      const response = await this.http.request({ method, url: path, data: body });
      return { status: response.status, data: response.data };
    } catch (error) {
      const err = error as { code?: string; message?: string };
      throw new SefinTransportError(`Sem resposta do ambiente nacional: ${err.message ?? 'erro de conexão'}`, err.code);
    }
  }

  /** Envia a DPS assinada e devolve a NFS-e autorizada ou as rejeições. */
  async emit(signedDpsXml: string): Promise<SefinResult> {
    const { status, data } = await this.request('POST', '/nfse', { dpsXmlGZipB64: packXml(signedDpsXml) });
    return parseSefinResponse(status, data);
  }

  async getNfse(accessKey: string): Promise<SefinResult> {
    const { status, data } = await this.request('GET', `/nfse/${accessKey}`);
    return parseSefinResponse(status, data);
  }

  /** Chave de acesso da NFS-e gerada a partir de uma DPS (404 = não gerada). */
  async getDps(dpsId: string): Promise<SefinResult> {
    const { status, data } = await this.request('GET', `/dps/${dpsId}`);
    return parseSefinResponse(status, data);
  }

  /** Só diz se a DPS já virou nota (true) ou não (false). */
  async dpsExists(dpsId: string): Promise<boolean> {
    const { status } = await this.request('HEAD', `/dps/${dpsId}`);
    if (status === 200) return true;
    if (status === 404) return false;
    throw new SefinTransportError(`Consulta da DPS respondeu HTTP ${status}`);
  }

  /** Registra um evento (cancelamento) com o pedido assinado. */
  async event(accessKey: string, signedEventXml: string): Promise<SefinResult> {
    const { status, data } = await this.request('POST', `/nfse/${accessKey}/eventos`, { pedidoRegistroEventoXmlGZipB64: packXml(signedEventXml) });
    return parseSefinResponse(status, data);
  }
}

// ------------------------------------------------------------------ distribuição (ADN Contribuintes)

export const ADN_URLS: Record<SefinEnvironment, string> = {
  producao: 'https://adn.nfse.gov.br/contribuintes',
  restrita: 'https://adn.producaorestrita.nfse.gov.br/contribuintes',
};

export function adnBaseUrl(environment: SefinEnvironment): string {
  const custom = environment === 'producao' ? process.env.FISCAL_ADN_URL : process.env.FISCAL_ADN_URL_RESTRITA;
  return (custom || ADN_URLS[environment]).replace(/\/+$/, '');
}

export interface DistributedDoc { nsu: number; accessKey: string | null; type: string; xml: string }

/**
 * Distribuição de documentos do Ambiente de Dados Nacional: devolve, a partir de
 * um NSU, os DF-e em que a empresa aparece (prestadora, tomadora ou
 * intermediária). 404 (E2220) = nada novo.
 */
export class AdnClient {
  private readonly http: AxiosInstance;

  constructor(environment: SefinEnvironment, certificate: Pick<LoadedCertificate, 'privateKeyPem' | 'certificatePem'>, timeoutMs = 60_000) {
    this.http = axios.create({
      baseURL: adnBaseUrl(environment),
      httpsAgent: new Agent({ key: certificate.privateKeyPem, cert: certificate.certificatePem, keepAlive: false }),
      timeout: timeoutMs,
      validateStatus: () => true,
      headers: { Accept: 'application/json' },
      transformResponse: [(data) => data],
    });
  }

  /** Lote de documentos a partir do NSU (exclusivo do último lido). */
  async fromNsu(nsu: number): Promise<{ docs: DistributedDoc[]; done: boolean; errors: SefinMessage[] }> {
    let response;
    try {
      response = await this.http.get(`/DFe/${nsu}`, { params: { lote: true } });
    } catch (error) {
      throw new SefinTransportError(`Sem resposta da distribuição: ${(error as Error).message}`);
    }
    const parsed = parseSefinResponse(response.status, response.data);
    const body = (parsed.raw ?? {}) as Record<string, unknown>;
    if (response.status === 404 || parsed.errors.some((e) => ['E2220', 'E2230'].includes(e.code))) return { docs: [], done: true, errors: [] };
    if (!parsed.ok) return { docs: [], done: true, errors: parsed.errors };
    const lote = (Object.entries(body).find(([k]) => k.toLowerCase() === 'lotedfe')?.[1] ?? []) as Array<Record<string, unknown>>;
    const get = (row: Record<string, unknown>, name: string) => Object.entries(row).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    const docs = lote.map((row) => ({
      nsu: Number(get(row, 'NSU') ?? 0),
      accessKey: get(row, 'ChaveAcesso') ? String(get(row, 'ChaveAcesso')) : null,
      type: String(get(row, 'TipoDocumento') ?? ''),
      xml: get(row, 'ArquivoXml') ? unpackXml(String(get(row, 'ArquivoXml'))) : '',
    }));
    return { docs, done: docs.length === 0, errors: [] };
  }
}
