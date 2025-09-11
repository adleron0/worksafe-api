export const paramsIncludes = {
  trainee: {
    select: {
      id: true,
      name: true,
      email: true,
      cpf: true,
    },
  },
  course: {
    select: {
      id: true,
      name: true,
      description: true,
    },
  },
  courseClass: {
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      company: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  },
};
