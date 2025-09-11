import { PrismaService } from 'src/prisma/prisma.service';
import { BadRequestException } from '@nestjs/common';
import { Request } from 'express';

export const noCompany = true;
export const omitAttributes = [];
export const encryptFields: string[] = [];

export function validateCreate(request: Request, CreateDto: any) {
  throw new BadRequestException('Não é permitido criar aulas por esta rota');
}

export function formaterPreUpdate(UpdateDto: any) {
  throw new BadRequestException('Não é permitido alterar aulas por esta rota');
}

async function hookPreCreate(params: {
  dto: any;
  entity: any;
  prisma: PrismaService;
  logParams: any;
}) {
  throw new BadRequestException('Operação não permitida');
}

async function hookPosCreate(
  params: {
    dto: any;
    entity: any;
    prisma: PrismaService;
    logParams: any;
  },
  created: any,
) {
  // Não utilizado
}

async function hookPreUpdate(params: {
  id: number;
  dto: any;
  entity: any;
  prisma: PrismaService;
  logParams: any;
}) {
  throw new BadRequestException('Operação não permitida');
}

async function hookPosUpdate(
  params: {
    id: number;
    dto: any;
    entity: any;
    prisma: PrismaService;
    logParams: any;
  },
  updated: any,
) {
  // Não utilizado
}

export const hooksCreate = {
  hookPreCreate,
  hookPosCreate,
};

export const hooksUpdate = {
  hookPreUpdate,
  hookPosUpdate,
};
