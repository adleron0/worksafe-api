export const paramsIncludes = {
  profile: {
    select: {
      name: true,
    },
  },
  permissions: {
    include: {
      permission: true,
    },
    where: {
      inactiveAt: null,
    },
  },
};
