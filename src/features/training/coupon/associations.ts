export const paramsIncludes = {
  seller: {
    select: {
      name: true,
    },
  },
  class: {
    select: {
      name: true,
    },
  },
  course: {
    select: {
      name: true,
    },
  },
  _count: {
    select: {
      financialRecords: {
        where: {
          status: { in: ['waiting', 'received'] },
        },
      },
    },
  },
};
