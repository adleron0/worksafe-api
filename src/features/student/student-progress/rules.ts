import { Request } from 'express';

export const noCompany = true;
export const omitAttributes = [];
export const encryptFields: string[] = [];

export function validateCreate(request: Request, CreateDto: any) {
  const traineeId = request['traineeId'];
  if (!traineeId) {
    throw new Error('Usuário não autenticado');
  }

  // Adicionar traineeId automaticamente
  CreateDto.traineeId = traineeId;

  // Validar que step existe
  if (!CreateDto.stepId) {
    throw new Error('Step é obrigatório');
  }

  // Validar progressPercent
  if (CreateDto.progressPercent !== undefined) {
    if (CreateDto.progressPercent < 0 || CreateDto.progressPercent > 100) {
      throw new Error('Progresso deve estar entre 0 e 100');
    }
  }
}

export function formaterPreUpdate(UpdateDto: any) {
  // Validar progressPercent se estiver sendo atualizado
  if (UpdateDto.progressPercent !== undefined) {
    if (UpdateDto.progressPercent < 0 || UpdateDto.progressPercent > 100) {
      throw new Error('Progresso deve estar entre 0 e 100');
    }
  }

  // Não permitir alterar traineeId ou stepId
  delete UpdateDto.traineeId;
  delete UpdateDto.stepId;
  delete UpdateDto.lessonId;

  return UpdateDto;
}

async function hookPreCreate(params) {
  // Adicionar firstAccessAt se não existir
  if (!params.data.firstAccessAt) {
    params.data.firstAccessAt = new Date();
  }

  // Adicionar lastAccessAt
  params.data.lastAccessAt = new Date();

  // Buscar lessonId do step
  const step = await params.prisma.onlineLessonStep.findUnique({
    where: { id: params.data.stepId },
    select: { lessonId: true, companyId: true },
  });

  if (!step) {
    throw new Error('Step não encontrado');
  }

  params.data.lessonId = step.lessonId;
  params.data.companyId = step.companyId;

  // Verificar se já existe progresso para este step
  const existing = await params.prisma.onlineStudentStepProgress.findUnique({
    where: {
      traineeId_stepId: {
        traineeId: params.data.traineeId,
        stepId: params.data.stepId,
      },
    },
  });

  if (existing) {
    throw new Error('Progresso já existe para este step');
  }
}

async function hookPosCreate(params, created) {
  // Atualizar progresso da aula
  await updateLessonProgress(
    params.prisma,
    created.traineeId,
    created.lessonId,
  );
}

async function hookPreUpdate(params) {
  // Atualizar lastAccessAt
  params.data.lastAccessAt = new Date();

  // Se está marcando como completo
  if (params.data.progressPercent === 100 && !params.data.completedAt) {
    params.data.completedAt = new Date();
  }

  // Se voltou de 100%, remover completedAt
  if (
    params.data.progressPercent !== undefined &&
    params.data.progressPercent < 100
  ) {
    params.data.completedAt = null;
  }
}

async function hookPosUpdate(params, updated) {
  // Atualizar progresso da aula
  await updateLessonProgress(
    params.prisma,
    updated.traineeId,
    updated.lessonId,
  );
}

// Função auxiliar para atualizar progresso da aula
async function updateLessonProgress(
  prisma: any,
  traineeId: number,
  lessonId: number,
) {
  // Buscar todos os steps da aula e seus progressos
  const lesson = await prisma.onlineLesson.findUnique({
    where: { id: lessonId },
    include: {
      steps: {
        include: {
          stepProgress: {
            where: { traineeId: traineeId },
          },
        },
      },
    },
  });

  if (!lesson) return;

  // Calcular progresso total
  const totalSteps = lesson.steps.length;
  const completedSteps = lesson.steps.filter(
    (step) => step.stepProgress?.[0]?.completedAt !== null,
  ).length;

  const progressPercent =
    totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

  // Atualizar ou criar progresso da aula
  await prisma.onlineStudentLessonProgress.upsert({
    where: {
      traineeId_lessonId: {
        traineeId: traineeId,
        lessonId: lessonId,
      },
    },
    update: {
      progress: progressPercent,
      completed: progressPercent === 100,
      completedAt: progressPercent === 100 ? new Date() : null,
    },
    create: {
      traineeId: traineeId,
      lessonId: lessonId,
      progress: progressPercent,
      completed: progressPercent === 100,
      startedAt: new Date(),
      completedAt: progressPercent === 100 ? new Date() : null,
      companyId: lesson.companyId,
    },
  });
}

export const hooksCreate = { hookPreCreate, hookPosCreate };
export const hooksUpdate = { hookPreUpdate, hookPosUpdate };
