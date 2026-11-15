import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * Converte endereço em ponto no mapa (latitude e longitude).
 *
 * Usa o Nominatim, do OpenStreetMap: gratuito, com a regra de no máximo uma
 * consulta por segundo e identificação de quem consulta. Por isso as consultas
 * passam por uma fila, uma de cada vez. Só o endereço vai para fora: nome de
 * cliente e qualquer dado de pessoa ficam aqui.
 *
 * `GEOCODER_DISABLED=true` desliga (testes); `GEOCODER_URL` troca o serviço.
 */
export interface GeocodeAddress { street?: string | null; number?: string | number | null; neighborhood?: string | null; city?: string | null; state?: string | null; zipCode?: string | null }
export interface GeocodeResult { latitude: number; longitude: number; /** o serviço achou a rua (true) ou só a cidade ou o bairro (false) */ precise: boolean; label: string }

const SPACING_MS = 1100;
const clean = (value: unknown) => String(value ?? '').trim();

@Injectable()
export class GeocoderService {
  private readonly logger = new Logger(GeocoderService.name);
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;

  get enabled() { return process.env.GEOCODER_DISABLED !== 'true'; }

  /** Uma consulta por vez, com o intervalo que o serviço pede. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.last + SPACING_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      try { return await task(); } finally { this.last = Date.now(); }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async search(params: Record<string, string>): Promise<Array<{ lat: string; lon: string; display_name: string; addresstype?: string; type?: string }>> {
    const base = (process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
    const response = await axios.get(`${base}/search`, {
      params: { ...params, format: 'jsonv2', limit: '1', countrycodes: 'br', 'accept-language': 'pt-BR' },
      headers: { 'User-Agent': process.env.GEOCODER_USER_AGENT || 'worksafe-app/1.0' }, timeout: 10000,
    });
    return Array.isArray(response.data) ? response.data : [];
  }

  /** O ponto de um endereço: tenta a rua; se não achar, a cidade (ponto aproximado). `null` se nem a cidade. */
  async locate(address: GeocodeAddress): Promise<GeocodeResult | null> {
    if (!this.enabled) return null;
    const city = clean(address.city);
    const state = clean(address.state);
    if (!city && !clean(address.zipCode)) return null;
    const street = [clean(address.number), clean(address.street)].filter(Boolean).join(' ');
    const attempts: Array<{ params: Record<string, string>; precise: boolean }> = [];
    if (street && city) attempts.push({ params: { street, city, ...(state ? { state } : {}) }, precise: true });
    if (city) attempts.push({ params: { city, ...(state ? { state } : {}) }, precise: false });
    for (const attempt of attempts) {
      try {
        const [hit] = await this.enqueue(() => this.search(attempt.params));
        const latitude = Number(hit?.lat);
        const longitude = Number(hit?.lon);
        if (hit && Number.isFinite(latitude) && Number.isFinite(longitude)) return { latitude, longitude, precise: attempt.precise, label: String(hit.display_name ?? '').slice(0, 300) };
      } catch (error) {
        this.logger.warn(`Conversão de endereço falhou: ${(error as Error)?.message ?? error}`);
        return null;
      }
    }
    return null;
  }
}
