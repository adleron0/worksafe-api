export const paramsIncludes = {
  trainee: {
    select: {
      id: true,
      name: true,
      email: true,
      cpf: true,
    },
  },
  lesson: {
    select: {
      id: true,
      title: true,
      description: true,
    },
  },
  courseClass: {
    select: {
      id: true,
      name: true,
      onlineCourseModel: {
        select: {
          course: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  },
};
