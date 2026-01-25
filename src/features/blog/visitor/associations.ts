export const paramsIncludes = {
  // Usuário interno vinculado (se houver)
  user: { select: { id: true, name: true, email: true, imageUrl: true } },
  // Contagem de comentários do visitante
  _count: { select: { comments: true } },
};
