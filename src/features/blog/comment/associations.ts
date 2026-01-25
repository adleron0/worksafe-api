export const paramsIncludes = {
  visitor: {
    include: {
      user: { select: { id: true, name: true, imageUrl: true } },
    },
  },
  replies: {
    where: { status: 'published', inactiveAt: null },
    include: {
      visitor: {
        include: {
          user: { select: { id: true, name: true, imageUrl: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
  post: { select: { id: true, title: true, slug: true } },
};
