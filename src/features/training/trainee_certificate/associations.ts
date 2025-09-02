export const paramsIncludes = {
  // Configure aqui os relacionamentos que devem ser incluídos nas consultas
  trainee: {
    select: {
      id: true,
      name: true,
      imageUrl: true,
    },
  },
  course: {
    select: {
      name: true,
      icon: true,
      color: true,
    },
  },
  class: {
    select: {
      name: true,
      description: true,
      initialDate: true,
      finalDate: true,
    },
  },
  company: {
    select: {
      cnpj: true,
      comercial_name: true,
      logoUrl: true,
      faviconUrl: true,
      websiteUrl: true,
    },
  },
};
