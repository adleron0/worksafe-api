import { CacheService } from 'src/common/cache/cache.service';

/**
 * Sessão de prova: aberta quando o aluno passa por POST /classes/validate-student
 * (CPF + código da turma). POST /exames/register só aceita a prova de quem
 * provou ser o aluno — antes bastava traineeId (sequencial) + classId e
 * qualquer um fazia a prova por qualquer aluno.
 *
 * Caminho preferido: o front reenvia `cpf` + `classCode` no register e o
 * servidor valida de novo. A sessão é a ponte de compatibilidade para o front
 * que ainda manda só traineeId/classId (a tela sempre passa pelo
 * validate-student antes); pode sair quando o front enviar as credenciais.
 */
export const EXAM_SESSION_TTL_SECONDS = 12 * 60 * 60;

const keyOf = (traineeId: number, classId: number) =>
  `exam-session:${traineeId}:${classId}`;

export async function openExamSession(
  cache: CacheService,
  traineeId: number,
  classId: number,
) {
  await cache.set(
    keyOf(traineeId, classId),
    { at: Date.now() },
    EXAM_SESSION_TTL_SECONDS,
  );
}

export async function hasExamSession(
  cache: CacheService,
  traineeId: number,
  classId: number,
) {
  return cache.exists(keyOf(traineeId, classId));
}

export async function closeExamSession(
  cache: CacheService,
  traineeId: number,
  classId: number,
) {
  await cache.del(keyOf(traineeId, classId));
}
