export const paramsIncludes = {
  steps: {
    orderBy: {
      order: 'asc',
    },
  },
  onlineCourseModel: {
    include: {
      course: {
        select: {
          id: true,
          name: true,
          description: true,
          workload: true,
        },
      },
    },
  },
  studentLessonProgress: false,
  studentStepProgress: false,
};
