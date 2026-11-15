import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Hr_Activity, Hr_ActivityType, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { SHIFTS, Shift, shiftOf } from './allocation';

/**
 * Atividades fora de OS: o que a pessoa faz que não é obra (dar aula, treinamento,
 * atividade no centro de treinamento, deslocamento, apoio numa base), num período
 * e numa parte do dia. Junto com a equipe das OS, alimenta o mapa de alocação.
 */
type Body = Record<string, any>;
export interface ActivityActor { userId: number; companyId: number }
export const ALLOCATION_VIEW_PERMISSION = 'view_alocacao';
export const ALLOCATION_WRITE_PERMISSION = 'update_alocacao';

/** Tipos com que cada empresa começa; quem cuida do mapa ajusta depois. */
const DEFAULT_TYPES: Array<{ name: string; color: string; occupies?: boolean }> = [
  { name: 'Aula como instrutor', color: '#7c3aed' },
  { name: 'Treinamento como aluno', color: '#0891b2' },
  { name: 'Atividade no CT', color: '#0f766e' },
  { name: 'Atividade interna', color: '#475569' },
  { name: 'Deslocamento', color: '#a16207' },
  { name: 'Apoio em base', color: '#be185d' },
  { name: 'Sobreaviso', color: '#64748b', occupies: false },
];

const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const blank = (value: unknown) => value === undefined || value === null || value === '';
const truthy = (value: unknown) => value === true || value === 'true' || value === 1 || value === '1';
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
function dateOf(value: unknown, label: string): string {
  const raw = /^(\d{4}-\d{2}-\d{2})(T.*)?$/.exec(String(value ?? '').trim())?.[1] ?? '';
  if (!raw || Number.isNaN(asDate(raw).getTime()) || iso(asDate(raw)) !== raw) throw new BadRequestException(`${label}: informe uma data válida`);
  return raw;
}

type ActivityFull = Hr_Activity & { type: Hr_ActivityType; employees: Array<{ employeeId: number; employee: { id: number; name: string } }> };
const INCLUDE = { type: true, employees: { include: { employee: { select: { id: true, name: true } } }, orderBy: { id: 'asc' as const } } };

@Injectable()
export class EmployeeActivityService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ tipos

  private async ensureDefaults(companyId: number): Promise<void> {
    if (await this.prisma.hr_ActivityType.count({ where: { companyId } })) return;
    await this.prisma.hr_ActivityType.createMany({ data: DEFAULT_TYPES.map((type) => ({ companyId, name: type.name, color: type.color, occupies: type.occupies ?? true })), skipDuplicates: true });
  }

  private presentType(type: Hr_ActivityType) {
    return { id: type.id, name: type.name, color: type.color, occupies: type.occupies, inactive: !!type.inactiveAt };
  }

  async types(actor: ActivityActor) {
    await this.ensureDefaults(actor.companyId);
    const rows = await this.prisma.hr_ActivityType.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' } });
    return { shifts: SHIFTS, rows: rows.map((type) => this.presentType(type)) };
  }

  private async typeData(companyId: number, body: Body, current: Hr_ActivityType | null): Promise<Prisma.Hr_ActivityTypeUncheckedUpdateInput> {
    const data: Prisma.Hr_ActivityTypeUncheckedUpdateInput = {};
    if ('name' in body || !current) {
      const name = clean(body.name, 80);
      if (name.length < 2) throw new BadRequestException('Informe o nome do tipo de atividade');
      const taken = await this.prisma.hr_ActivityType.findFirst({ where: { companyId, name: { equals: name, mode: 'insensitive' }, ...(current ? { id: { not: current.id } } : {}) }, select: { id: true } });
      if (taken) throw new ConflictException('Já existe um tipo de atividade com este nome');
      data.name = name;
    }
    if ('color' in body) {
      const color = String(body.color ?? '').trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new BadRequestException('Cor inválida');
      data.color = color.toLowerCase();
    }
    if ('occupies' in body) data.occupies = truthy(body.occupies);
    return data;
  }

  async createType(actor: ActivityActor, body: Body) {
    await this.ensureDefaults(actor.companyId);
    const data = await this.typeData(actor.companyId, body, null);
    return this.presentType(await this.prisma.hr_ActivityType.create({ data: { ...(data as Prisma.Hr_ActivityTypeUncheckedCreateInput), companyId: actor.companyId } }));
  }

  async updateType(actor: ActivityActor, id: number, body: Body) {
    const type = await this.prisma.hr_ActivityType.findFirst({ where: { id, companyId: actor.companyId } });
    if (!type) throw new NotFoundException('Tipo de atividade não encontrado');
    return this.presentType(await this.prisma.hr_ActivityType.update({ where: { id }, data: await this.typeData(actor.companyId, body, type) }));
  }

  /** Tipo inativo não aceita atividade nova; as que já existem continuam no mapa. */
  async inactivateType(actor: ActivityActor, id: number) {
    const type = await this.prisma.hr_ActivityType.findFirst({ where: { id, companyId: actor.companyId } });
    if (!type) throw new NotFoundException('Tipo de atividade não encontrado');
    return this.presentType(await this.prisma.hr_ActivityType.update({ where: { id }, data: { inactiveAt: new Date() } }));
  }

  // ------------------------------------------------------------------ atividades

  private present(activity: ActivityFull) {
    return {
      id: activity.id, typeId: activity.typeId, typeName: activity.type.name, color: activity.type.color, occupies: activity.type.occupies, location: activity.location, placeId: activity.placeId,
      startDate: iso(activity.startDate)!, endDate: iso(activity.endDate)!, shift: shiftOf(activity.shift) as Shift, notes: activity.notes,
      employees: activity.employees.map((member) => member.employee),
    };
  }

  private async byId(companyId: number, id: number): Promise<ActivityFull> {
    const activity = await this.prisma.hr_Activity.findFirst({ where: { id, companyId, inactiveAt: null }, include: INCLUDE });
    if (!activity) throw new NotFoundException('Atividade não encontrada');
    return activity;
  }

  /** As atividades que tocam uma janela de datas. */
  async list(actor: ActivityActor, query: Record<string, string>) {
    const from = blank(query.from) ? null : dateOf(query.from, 'Início');
    const to = blank(query.to) ? null : dateOf(query.to, 'Fim');
    const rows = await this.prisma.hr_Activity.findMany({
      where: { companyId: actor.companyId, inactiveAt: null, ...(to ? { startDate: { lte: asDate(to) } } : {}), ...(from ? { endDate: { gte: asDate(from) } } : {}) },
      include: INCLUDE, orderBy: [{ startDate: 'asc' }, { id: 'asc' }], take: 1000,
    });
    return { rows: rows.map((activity) => this.present(activity)) };
  }

  async get(actor: ActivityActor, id: number) {
    return this.present(await this.byId(actor.companyId, id));
  }

  private async dataOf(companyId: number, body: Body, current: ActivityFull | null) {
    const data: Prisma.Hr_ActivityUncheckedUpdateInput = {};
    if ('typeId' in body || !current) {
      const type = await this.prisma.hr_ActivityType.findFirst({ where: { id: Number(body.typeId), companyId, inactiveAt: null }, select: { id: true } });
      if (!type) throw new BadRequestException('Escolha o tipo da atividade');
      data.typeId = type.id;
    }
    const start = 'startDate' in body || !current ? dateOf(body.startDate, 'Início') : iso(current.startDate)!;
    const end = 'endDate' in body || !current ? (blank(body.endDate) ? start : dateOf(body.endDate, 'Fim')) : iso(current.endDate)!;
    if (end < start) throw new BadRequestException('O fim não pode ser antes do início');
    if ((asDate(end).getTime() - asDate(start).getTime()) / 86400000 > 366) throw new BadRequestException('Atividade longa demais: até um ano');
    data.startDate = asDate(start);
    data.endDate = asDate(end);
    if ('shift' in body || !current) {
      const shift = blank(body.shift) ? 'integral' : String(body.shift);
      if (!SHIFTS.some((item) => item.id === shift)) throw new BadRequestException('Parte do dia inválida');
      data.shift = shift;
    }
    if ('placeId' in body) {
      if (blank(body.placeId)) data.placeId = null;
      else {
        const place = await this.prisma.company_Place.findFirst({ where: { id: Number(body.placeId), companyId }, select: { id: true, name: true } });
        if (!place) throw new BadRequestException('Local não encontrado');
        data.placeId = place.id;
        // sem texto digitado, o "onde" é o nome do local
        if (blank(body.location)) body = { ...body, location: place.name };
      }
    }
    if ('location' in body) data.location = clean(body.location, 200) || null;
    if ('notes' in body) data.notes = clean(body.notes, 500) || null;

    let employeeIds: number[] | null = null;
    if ('employeeIds' in body || !current) {
      employeeIds = Array.isArray(body.employeeIds) ? [...new Set((body.employeeIds as unknown[]).map(Number).filter((id) => Number.isInteger(id) && id > 0))] : [];
      if (!employeeIds.length) throw new BadRequestException('Escolha pelo menos uma pessoa');
      if (employeeIds.length > 200) throw new BadRequestException('Pessoas demais numa atividade');
      // quem já saiu da empresa antes do início não entra em atividade nova
      const found = await this.prisma.hr_Employee.findMany({ where: { id: { in: employeeIds }, companyId, inactiveAt: null }, select: { id: true, name: true, terminationDate: true } });
      if (found.length !== employeeIds.length) throw new BadRequestException('Pessoa não encontrada no cadastro de funcionários');
      const gone = found.find((employee) => employee.terminationDate && iso(employee.terminationDate)! <= start);
      if (gone) throw new BadRequestException(`${gone.name} foi desligado antes do início da atividade`);
    }
    return { data, employeeIds };
  }

  async create(actor: ActivityActor, body: Body) {
    await this.ensureDefaults(actor.companyId);
    const { data, employeeIds } = await this.dataOf(actor.companyId, body, null);
    const created = await this.prisma.hr_Activity.create({
      data: { ...(data as Prisma.Hr_ActivityUncheckedCreateInput), companyId: actor.companyId, createdByUserId: actor.userId || null, employees: { create: (employeeIds ?? []).map((employeeId) => ({ employeeId })) } },
    });
    return this.get(actor, created.id);
  }

  async update(actor: ActivityActor, id: number, body: Body) {
    const current = await this.byId(actor.companyId, id);
    const { data, employeeIds } = await this.dataOf(actor.companyId, body, current);
    await this.prisma.$transaction(async (tx) => {
      await tx.hr_Activity.update({ where: { id }, data });
      if (!employeeIds) return;
      await tx.hr_ActivityEmployee.deleteMany({ where: { activityId: id } });
      await tx.hr_ActivityEmployee.createMany({ data: employeeIds.map((employeeId) => ({ activityId: id, employeeId })) });
    });
    return this.get(actor, id);
  }

  /** Cancela a atividade: ela sai do mapa e fica guardada, inativa. */
  async remove(actor: ActivityActor, id: number) {
    await this.byId(actor.companyId, id);
    await this.prisma.hr_Activity.update({ where: { id }, data: { inactiveAt: new Date() } });
    return { id };
  }
}
