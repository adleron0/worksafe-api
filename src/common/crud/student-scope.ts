import { ScopeResolver } from '@adleron/crud-core';
import { UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { StudentAuthGuard } from 'src/auth/guards/student-auth.guard';

/** Escopo do aluno: a coluna `field` compara com o traineeId do token de aluno. */
export const studentScope = (field: string): ScopeResolver<Request> => ({
  field,
  resolve: (request) => {
    const id = request['traineeId'];
    return id === undefined || id === null ? undefined : Number(id);
  },
});

/** Todas as ops de entidade do aluno passam pelo StudentAuthGuard (popula request.traineeId). */
export const studentGuard = UseGuards(StudentAuthGuard);
