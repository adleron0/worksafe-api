import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Company_Place, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { GeocodeAddress, GeocoderService } from './geocoder.service';

/**
 * Locais da empresa (centros de treinamento, bases temporárias, sede) e o ponto
 * no mapa dos clientes. O ponto vem do endereço, convertido uma vez e gravado,
 * e pode sempre ser ajustado à mão: endereço de planta industrial costuma cair
 * no lugar errado.
 */
type Body = Record<string, any>;
export interface PlaceActor { userId: number; companyId: number }
export const PLACE_KINDS = [{ id: 'ct', name: 'Centro de treinamento' }, { id: 'base', name: 'Base temporária' }, { id: 'sede', name: 'Sede' }, { id: 'outro', name: 'Outro' }];

const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const blank = (value: unknown) => value === undefined || value === null || value === '';
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
function dateOf(value: unknown, label: string): string {
  const raw = /^(\d{4}-\d{2}-\d{2})(T.*)?$/.exec(String(value ?? '').trim())?.[1] ?? '';
  if (!raw || Number.isNaN(asDate(raw).getTime()) || iso(asDate(raw)) !== raw) throw new BadRequestException(`${label}: informe uma data válida`);
  return raw;
}
/** Latitude e longitude válidas, ou as duas em branco (sem ponto). */
export function pointOf(body: Body): { latitude: number | null; longitude: number | null } {
  if (blank(body.latitude) && blank(body.longitude)) return { latitude: null, longitude: null };
  const latitude = Number(body.latitude);
  const longitude = Number(body.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new BadRequestException('Ponto no mapa inválido');
  return { latitude: Math.round(latitude * 1e6) / 1e6, longitude: Math.round(longitude * 1e6) / 1e6 };
}

@Injectable()
export class PlaceService {
  constructor(private readonly prisma: PrismaService, private readonly geocoder: GeocoderService) {}

  // ------------------------------------------------------------------ locais da empresa

  private present(place: Company_Place, day = today()) {
    const start = iso(place.startDate);
    const end = iso(place.endDate);
    return {
      id: place.id, name: place.name, kind: place.kind, kindName: PLACE_KINDS.find((kind) => kind.id === place.kind)?.name ?? place.kind,
      street: place.street, number: place.number, neighborhood: place.neighborhood, city: place.city, state: place.state, zipCode: place.zipCode,
      address: [[place.street, place.number].filter(Boolean).join(', '), place.neighborhood, [place.city, place.state].filter(Boolean).join('/')].filter(Boolean).join(' · ') || null,
      latitude: place.latitude, longitude: place.longitude, startDate: start, endDate: end, notes: place.notes,
      // base temporária fora do período não está em uso (ainda não abriu ou já encerrou)
      current: (!start || start <= day) && (!end || end >= day), inactive: !!place.inactiveAt,
    };
  }

  async list(actor: PlaceActor, query: Record<string, string> = {}) {
    const rows = await this.prisma.company_Place.findMany({ where: { companyId: actor.companyId, ...(query.inactive === 'true' ? {} : { inactiveAt: null }) }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] });
    return { kinds: PLACE_KINDS, geocoder: this.geocoder.enabled, rows: rows.map((place) => this.present(place)) };
  }

  private async byId(companyId: number, id: number) {
    const place = await this.prisma.company_Place.findFirst({ where: { id, companyId } });
    if (!place) throw new NotFoundException('Local não encontrado');
    return place;
  }

  private dataOf(body: Body, current: Company_Place | null): Prisma.Company_PlaceUncheckedUpdateInput {
    const data: Prisma.Company_PlaceUncheckedUpdateInput = {};
    if ('name' in body || !current) {
      const name = clean(body.name, 120);
      if (name.length < 2) throw new BadRequestException('Informe o nome do local');
      data.name = name;
    }
    if ('kind' in body || !current) {
      const kind = blank(body.kind) ? 'ct' : String(body.kind);
      if (!PLACE_KINDS.some((item) => item.id === kind)) throw new BadRequestException('Tipo de local inválido');
      data.kind = kind;
    }
    for (const [key, max] of [['street', 200], ['number', 20], ['neighborhood', 120], ['city', 120], ['zipCode', 10], ['notes', 500]] as const) if (key in body) data[key] = clean(body[key], max) || null;
    if ('state' in body) data.state = clean(body.state, 2).toUpperCase() || null;
    if ('latitude' in body || 'longitude' in body) Object.assign(data, pointOf(body));
    const start = 'startDate' in body ? (blank(body.startDate) ? null : dateOf(body.startDate, 'Início')) : iso(current?.startDate);
    const end = 'endDate' in body ? (blank(body.endDate) ? null : dateOf(body.endDate, 'Fim')) : iso(current?.endDate);
    if (start && end && end < start) throw new BadRequestException('O fim não pode ser antes do início');
    if ('startDate' in body) data.startDate = start ? asDate(start) : null;
    if ('endDate' in body) data.endDate = end ? asDate(end) : null;
    return data;
  }

  async create(actor: PlaceActor, body: Body) {
    const data = this.dataOf(body, null);
    const created = await this.prisma.company_Place.create({ data: { ...(data as Prisma.Company_PlaceUncheckedCreateInput), companyId: actor.companyId } });
    return this.present(created);
  }

  async update(actor: PlaceActor, id: number, body: Body) {
    const place = await this.byId(actor.companyId, id);
    return this.present(await this.prisma.company_Place.update({ where: { id }, data: this.dataOf(body, place) }));
  }

  async setActive(actor: PlaceActor, id: number, active: boolean) {
    await this.byId(actor.companyId, id);
    return this.present(await this.prisma.company_Place.update({ where: { id }, data: { inactiveAt: active ? null : new Date() } }));
  }

  /** Converte um endereço em ponto, sem gravar: a tela mostra o resultado e a pessoa confirma ou arrasta. */
  async geocode(body: Body) {
    const address: GeocodeAddress = { street: clean(body.street, 200), number: clean(body.number, 20), neighborhood: clean(body.neighborhood, 120), city: clean(body.city, 120), state: clean(body.state, 40), zipCode: clean(body.zipCode, 10) };
    if (!address.city) throw new BadRequestException('Informe pelo menos a cidade para localizar o endereço');
    const result = await this.geocoder.locate(address);
    return { found: !!result, enabled: this.geocoder.enabled, ...(result ?? {}) };
  }

  // ------------------------------------------------------------------ ponto dos clientes

  private presentCustomer(customer: { id: number; name: string; street: string | null; number: number | null; neighborhood: string | null; latitude: number | null; longitude: number | null; geocodedAt: Date | null; city: { name: string } | null; state: { uf: string } | null }) {
    return {
      id: customer.id, name: customer.name,
      address: [[customer.street, customer.number || null].filter(Boolean).join(', '), customer.neighborhood, [customer.city?.name, customer.state?.uf].filter(Boolean).join('/')].filter(Boolean).join(' · ') || null,
      city: customer.city?.name ?? null, state: customer.state?.uf ?? null, latitude: customer.latitude, longitude: customer.longitude,
      // de onde veio o ponto: do endereço (pode estar aproximado) ou ajustado à mão
      source: customer.latitude === null ? null : customer.geocodedAt ? 'endereco' : 'manual',
    };
  }
  private readonly customerSelect = { id: true, name: true, street: true, number: true, neighborhood: true, latitude: true, longitude: true, geocodedAt: true, city: { select: { name: true } }, state: { select: { uf: true } } } as const;

  /** Clientes e o ponto de cada um no mapa. */
  async customers(actor: PlaceActor, query: Record<string, string>) {
    const term = clean(query.search, 80);
    const where: Prisma.CustomerWhereInput = {
      companyId: actor.companyId, inactiveAt: null,
      ...(term ? { OR: [{ name: { contains: term, mode: 'insensitive' } }, { corporateName: { contains: term, mode: 'insensitive' } }] } : {}),
      ...(query.missing === 'true' ? { latitude: null } : {}),
    };
    const [rows, total, missing] = await Promise.all([
      this.prisma.customer.findMany({ where, select: this.customerSelect, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 500 }),
      this.prisma.customer.count({ where: { companyId: actor.companyId, inactiveAt: null } }),
      this.prisma.customer.count({ where: { companyId: actor.companyId, inactiveAt: null, latitude: null } }),
    ]);
    return { geocoder: this.geocoder.enabled, total, missing, rows: rows.map((customer) => this.presentCustomer(customer)) };
  }

  private async customerById(companyId: number, id: number) {
    const customer = await this.prisma.customer.findFirst({ where: { id, companyId }, select: this.customerSelect });
    if (!customer) throw new NotFoundException('Cliente não encontrado');
    return customer;
  }

  /** Grava o ponto de um cliente ajustado à mão (ou tira o ponto, com as duas coordenadas em branco). */
  async setCustomerPoint(actor: PlaceActor, id: number, body: Body) {
    await this.customerById(actor.companyId, id);
    const point = pointOf(body);
    const saved = await this.prisma.customer.update({ where: { id }, data: { ...point, geocodedAt: null }, select: this.customerSelect });
    return this.presentCustomer(saved);
  }

  /** Calcula o ponto de um cliente pelo endereço do cadastro e grava. */
  async locateCustomer(actor: PlaceActor, id: number) {
    const customer = await this.customerById(actor.companyId, id);
    const result = await this.geocoder.locate({ street: customer.street, number: customer.number || null, neighborhood: customer.neighborhood, city: customer.city?.name, state: customer.state?.uf });
    if (!result) return { found: false, precise: false, customer: this.presentCustomer(customer) };
    const saved = await this.prisma.customer.update({ where: { id }, data: { latitude: result.latitude, longitude: result.longitude, geocodedAt: new Date() }, select: this.customerSelect });
    return { found: true, precise: result.precise, customer: this.presentCustomer(saved) };
  }

  /**
   * Calcula o ponto de vários clientes que ainda não têm, um por vez (o serviço
   * pede um intervalo entre consultas). Faz um lote pequeno por chamada, para a
   * resposta não demorar; a tela chama de novo enquanto houver quem falte.
   */
  async locateMissing(actor: PlaceActor, body: Body) {
    const limit = Math.min(10, Math.max(1, Number(body.limit) || 5));
    const skip = Array.isArray(body.skip) ? (body.skip as unknown[]).map(Number).filter((id) => id > 0) : [];
    const pending = await this.prisma.customer.findMany({ where: { companyId: actor.companyId, inactiveAt: null, latitude: null, ...(skip.length ? { id: { notIn: skip } } : {}) }, select: { id: true }, orderBy: { id: 'asc' }, take: limit });
    const done: number[] = [];
    const failed: number[] = [];
    for (const row of pending) {
      const result = await this.locateCustomer(actor, row.id);
      (result.found ? done : failed).push(row.id);
    }
    const remaining = await this.prisma.customer.count({ where: { companyId: actor.companyId, inactiveAt: null, latitude: null, id: { notIn: [...skip, ...failed] } } });
    return { located: done.length, failed, remaining, enabled: this.geocoder.enabled };
  }
}
