export const paramsIncludes = {
  class: {
    include: {
      onlineCourseModel: {
        include: {
          course: {
            select: {
              id: true,
              name: true,
              description: true,
            },
          },
          lessons: {
            include: {
              lesson: {
                select: {
                  id: true,
                  title: true,
                  description: true,
                },
              },
            },
            orderBy: {
              order: 'asc',
            },
          },
        },
      },
      company: true,
    },
  },
  trainee: {
    select: {
      id: true,
      name: true,
      email: true,
      cpf: true,
    },
  },
};
