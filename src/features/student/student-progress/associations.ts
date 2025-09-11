export const paramsIncludes = {
  onlineLessonStep: {
    include: {
      onlineLesson: {
        select: {
          id: true,
          name: true,
          order: true,
        },
      },
    },
  },
  trainee: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
};
