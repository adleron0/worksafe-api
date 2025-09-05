export const paramsIncludes = {
  // Configure aqui os relacionamentos que devem ser incluídos nas consultas
  steps: true,
  studentStepProgress: false,
  studentLessonProgress: false,
  modelLessons: {
    include: {
      model: {
        include: {
          course: true,
        },
      },
    },
  },
  course: {
    select: {
      id: true,
      name: true,
    },
  },
};
