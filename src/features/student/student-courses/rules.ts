import { PrismaService } from 'src/prisma/prisma.service';
import { BadRequestException } from '@nestjs/common';
import { Request } from 'express';

export const noCompany = true;
export const omitAttributes = [];
export const encryptFields: string[] = [];

export function validateCreate(request: Request, CreateDto: any) {
  const traineeId = request['traineeId'];
  if (!traineeId) {
    throw new BadRequestException('Aluno não autenticado');
  }

  return {
    where: {
      traineeId: traineeId,
      courseClassId: CreateDto.courseClassId,
    },
  };
}

export function formaterPreUpdate(UpdateDto: any) {
  return UpdateDto;
}

async function hookPreCreate(params: {
  dto: any;
  entity: any;
  prisma: PrismaService;
  logParams: any;
}) {
  const { dto, prisma, logParams } = params;

  const courseClass = await prisma.courseClass.findUnique({
    where: { id: dto.courseClassId },
  });

  if (!courseClass) {
    throw new BadRequestException('Turma não encontrada');
  }

  if (!courseClass.active) {
    throw new BadRequestException('Turma inativa');
  }

  const now = new Date();

  // Verifica período de inscrições
  if (courseClass.periodSubscriptionsType === 'LIMITED') {
    if (
      courseClass.periodSubscriptionsInitialDate &&
      now < courseClass.periodSubscriptionsInitialDate
    ) {
      throw new BadRequestException('Período de inscrição ainda não iniciado');
    }
    if (
      courseClass.periodSubscriptionsFinalDate &&
      now > courseClass.periodSubscriptionsFinalDate
    ) {
      throw new BadRequestException('Período de inscrição encerrado');
    }
  }

  // Verifica período da turma
  if (courseClass.periodClass === 'LIMITED') {
    if (courseClass.finalDate && now > courseClass.finalDate) {
      throw new BadRequestException('Turma já encerrada');
    }
  }

  const enrollmentCount = await prisma.courseClassSubscription.count({
    where: {
      classId: dto.courseClassId,
      subscribeStatus: {
        not: 'declined',
      },
    },
  });

  const maxStudents = courseClass.maxSubscriptions || 50;
  if (!courseClass.unlimitedSubscriptions && enrollmentCount >= maxStudents) {
    throw new BadRequestException('Turma sem vagas disponíveis');
  }

  const existingEnrollment = await prisma.courseClassSubscription.findFirst({
    where: {
      traineeId: logParams.userId,
      classId: dto.courseClassId,
    },
  });

  if (existingEnrollment) {
    if (existingEnrollment.subscribeStatus !== 'declined') {
      throw new BadRequestException('Você já está inscrito nesta turma');
    } else {
      throw new BadRequestException(
        'Você já possui uma inscrição cancelada nesta turma',
      );
    }
  }

  // Pega dados do trainee para preencher a inscrição
  const trainee = await prisma.trainee.findUnique({
    where: { id: logParams.userId },
  });

  if (!trainee) {
    throw new BadRequestException('Aluno não encontrado');
  }

  dto.traineeId = logParams.userId;
  dto.classId = dto.courseClassId;
  dto.name = trainee.name;
  dto.cpf = trainee.cpf;
  dto.email = trainee.email;
  dto.phone = trainee.phone || '';
  dto.subscribeStatus = 'confirmed';
  dto.confirmedAt = new Date();
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
  const { prisma } = params;

  // Log removido pois a tabela Log não existe no schema atual
}

async function hookPreUpdate(params: {
  id: number;
  dto: any;
  entity: any;
  prisma: PrismaService;
  logParams: any;
}) {
  const { id, prisma, logParams } = params;

  const enrollment = await prisma.courseClassSubscription.findUnique({
    where: { id: Number(id) },
  });

  if (!enrollment) {
    throw new BadRequestException('Inscrição não encontrada');
  }

  if (enrollment.traineeId !== logParams.userId) {
    throw new BadRequestException(
      'Sem autorização para alterar esta inscrição',
    );
  }
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
  // Lógica de pós-atualização pode ser adicionada aqui se necessário
}

export const hooksCreate = {
  hookPreCreate,
  hookPosCreate,
};

export const hooksUpdate = {
  hookPreUpdate,
  hookPosUpdate,
};
