import { PrismaClient } from '@prisma/client';
import { permission } from 'process';
const prisma = new PrismaClient();

// --------------------------------------------------------------------------------
async function seedCompanies() {
  const companiesData = [
    {
      comercial_name: 'Worksafe Brasil',
      corporate_name: 'Worksafe Servicos Ltda',
      cnpj: '33714458000161',
      region: 'Nordeste',
      state: 'PE',
      representative_email: 'julio@worksafebrasil.com.br',
      segment: 'Servicos',
    },
  ];

  for (const company of companiesData) {
    await prisma.company.create({
      data: company,
    });
  }

  console.log('Seed da tabela Company executado com sucesso!');
}

// --------------------------------------------------------------------------------
async function seedProducts() {
  const productsData = [
    { name: 'Confinus', groupPermission: 'confinus' },
    { name: 'Altus', groupPermission: 'altus' },
    { name: 'Protex', groupPermission: 'protex' },
    { name: 'e-Rdo', groupPermission: 'e-rdo' },
    { name: 'Certus', groupPermission: 'certus' },
  ];

  for (const product of productsData) {
    await prisma.product.create({
      data: product,
    });
  }

  console.log('Seed da tabela Product executado com sucesso!');
}

// --------------------------------------------------------------------------------
async function seedRanks() {
  const productsData = [
    { name: 'Bronze', color: null, companyId: 1 },
    { name: 'Prata', color: null, companyId: 1 },
    { name: 'Ouro', color: null, companyId: 1 },
  ];

  for (const product of productsData) {
    await prisma.dOM_Ranks.create({
      data: product,
    });
  }

  console.log('Seed da tabela Ranks executado com sucesso!');
}

// --------------------------------------------------------------------------------
async function seedCompanyProducts() {
  // Busca todos os produtos cadastrados
  const products = await prisma.product.findMany();

  if (products.length === 0) {
    throw new Error(
      'Nenhum produto encontrado. Execute o seed de Product primeiro.',
    );
  }

  // Para cada produto, cria uma associação com a empresa de id 1
  for (const product of products) {
    await prisma.companyProduct.create({
      data: {
        companyId: 1, // Define a associação para a empresa com id 1
        productId: product.id,
      },
    });
  }

  console.log('Seed da tabela CompanyProduct executado com sucesso!');
}

// --------------------------------------------------------------------------------
async function seedRoles() {
  const rolesData = [{ name: 'admin' }, { name: 'manager' }, { name: 'user' }];

  for (const role of rolesData) {
    await prisma.role.create({
      data: role,
    });
  }

  console.log('Seed da tabela Role executado com sucesso!');
}

// --------------------------------------------------------------------------------
async function seedUsers() {
  const usersData = [
    {
      name: 'Júlio Adler',
      email: 'julio@worksafebrasil.com.br',
      password: '$2b$10$SuTOTad7G9mxNpgZxcFB4un..5ghSm4Tk3GX8WR.TIMa.km6b2AEy',
      imageUrl:
        'https://worksafe-brasil.s3.us-east-1.amazonaws.com/user-profile/1743635645163_J%C3%BAlio_Adler',
      phone: '81996764688',
      cpf: '11622612426',
      companyId: 1,
      roleId: 1,
    },
  ];

  for (const user of usersData) {
    await prisma.user.create({
      data: user,
    });
  }

  console.log('Seed da tabela User executado com sucesso!');
}

// --------------------------------------------------------------------------------
async function seedPermissions() {
  // Definição dos prefixos com o rótulo para a descrição
  const prefixes = [
    { key: 'view_', label: 'Ver' },
    { key: 'create_', label: 'Criar' },
    { key: 'list_', label: 'Listar' },
    { key: 'activate_', label: 'Ativar' },
    { key: 'inactive_', label: 'Inativar' },
    { key: 'update_', label: 'Editar' },
  ];

  // Entidades que serão combinadas com os prefixos
  const entities = [
    { permission: 'inventarios', name: 'inventarios', group: 'inventarios' },
    { permission: 'area_inventarios', name: 'area', group: 'inventarios' },
    {
      permission: 'subarea_inventarios',
      name: 'subarea',
      group: 'inventarios',
    },
    { permission: 'treinamentos', name: 'treinamentos', group: 'treinamentos' },
    { permission: 'certificados', name: 'certificados', group: 'treinamentos' },
    {
      permission: 'treinamentos_orcamentos',
      name: 'orcamentos',
      group: 'comercial',
    },
    { permission: 'servicos', name: 'servicos', group: 'servicos' },
    {
      permission: 'servicos_orcamentos',
      name: 'orcamentos',
      group: 'comercial',
    },
    {
      permission: 'ordens_de_servico',
      name: 'OS',
      group: 'servicos',
    },
    { permission: 'almox', name: 'almox', group: 'almox' },
    { permission: 'financeiro', name: 'financeiro', group: 'financeiro' },
    { permission: 'compras', name: 'compras', group: 'financeiro' },
    {
      permission: 'notas_fiscais',
      name: 'notas fiscais',
      group: 'financeiro',
    },
    { permission: 'produtos', name: 'produtos', group: 'produtos' },
    { permission: 'comercial', name: 'comercial', group: 'comercial' },
    {
      permission: 'produtos_orcamentos',
      name: 'orcamentos',
      group: 'comercial',
    },
    { permission: 'clientes', name: 'clientes', group: 'clientes' },
    { permission: 'user', name: 'user', group: 'user' },
  ];

  const permissionsData = [];

  for (const prefix of prefixes) {
    for (const entity of entities) {
      // Gera o nome da permissão: concatena o prefixo com o campo permission da entidade
      const permissionName = `${prefix.key}${entity.permission}`;

      // Para a descrição, utiliza o campo name:
      // Se o name for 'user', formata para 'Usuário', senão capitaliza a primeira letra
      const formattedName =
        entity.name === 'user'
          ? 'Usuário'
          : entity.name.charAt(0).toUpperCase() + entity.name.slice(1);

      const description = `${prefix.label} ${formattedName}`;

      // O group é obtido diretamente do objeto
      const group = entity.group;

      permissionsData.push({ name: permissionName, description, group });
    }
  }

  // Inserção das permissões no banco de dados
  for (const permission of permissionsData) {
    await prisma.permission.create({
      data: permission,
    });
  }

  console.log('Seed da tabela Permission executado com sucesso!');
}

// --------------------------------------------------------------------------------
async function seedRolePermissions() {
  // Busca todas as permissões cujo nome termina com '_user'
  const userPermissions = await prisma.permission.findMany({
    where: {
      name: {
        endsWith: '_user',
      },
    },
  });

  if (!userPermissions || userPermissions.length === 0) {
    throw new Error(
      'Nenhuma permissão de usuário encontrada. Execute o seed de Permission primeiro.',
    );
  }

  // Associa cada permissão encontrada à role com id 1
  for (const permission of userPermissions) {
    await prisma.rolePermission.create({
      data: {
        roleId: 1, // Role para a qual será atribuída a permissão
        permissionId: permission.id,
      },
    });
  }

  console.log('Seed da tabela RolePermission executado com sucesso!');
}

// Executa as Seeds ----------------------------------------------------------------
async function main() {
  await seedCompanies();
  await seedProducts();
  await seedRanks();
  await seedCompanyProducts();
  await seedRoles();
  await seedUsers();
  await seedPermissions();
  await seedRolePermissions();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
