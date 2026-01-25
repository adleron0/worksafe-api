export const paramsIncludes = {
  // Visitante que fez o comentário
  visitor: {
    select: {
      id: true,
      name: true,
      email: true,
      avatarUrl: true,
      blocked: true,
    },
  },
  // Post relacionado
  post: { select: { id: true, title: true, slug: true } },
  // Respostas ao comentário
  replies: {
    include: {
      visitor: {
        select: {
          id: true,
          name: true,
          email: true,
          avatarUrl: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' as const },
  },
};
