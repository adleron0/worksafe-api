export const paramsIncludes = {
  author: { select: { id: true, name: true, imageUrl: true } },
  category: { select: { id: true, name: true, slug: true } },
  tags: { include: { tag: true } },
  _count: { select: { comments: true } },
};
