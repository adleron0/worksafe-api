/* eslint-disable */
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcrypt';

const prisma = new PrismaClient();

// --------------------------------------------------------------------------------
async function seedCompanies() {
  const companiesData = [
    {
      comercial_name: 'Worksafe Brasil',
      corporate_name: 'Worksafe Servicos Ltda',
      cnpj: '33714458000161',
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
  const ranksData = [
    { name: 'Bronze', color: null, companyId: 1 },
    { name: 'Prata', color: null, companyId: 1 },
    { name: 'Ouro', color: null, companyId: 1 },
  ];

  for (const rank of ranksData) {
    await prisma.dOM_Ranks.create({
      data: rank,
    });
  }

  console.log('Seed da tabela DOM Ranks executado com sucesso!');
}

// --------------------------------------------------------------------------------
async function seedDomRoles() {
  const rolesData = [
    { name: 'Gerencia' },
    { name: 'Segurança do Trabalho' },
    { name: 'Financeiro' },
  ];

  for (const roles of rolesData) {
    await prisma.dOM_Roles.create({
      data: roles,
    });
  }

  console.log('Seed da tabela DOM Roles executado com sucesso!');
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
async function seedProfiles() {
  const profilesData = [
    { name: 'super', companyId: 0 },
    { name: 'admin', companyId: 1 },
    { name: 'user', companyId: 1 },
  ];

  for (const profile of profilesData) {
    await prisma.profile.create({
      data: profile,
    });
  }

  console.log('Seed da tabela Profile executado com sucesso!');
}

// --------------------------------------------------------------------------------
async function seedUsers() {
  const unHashedPassword = 'senha@123';
  const saltRounds = 10;
  const passwordHashed = await hash(unHashedPassword, saltRounds);

  const usersData = [
    {
      name: 'Júlio Adler',
      email: 'julio@worksafebrasil.com.br',
      password: passwordHashed,
      imageUrl:
        'https://worksafe-brasil.s3.us-east-1.amazonaws.com/user-profile/1743635645163_J%C3%BAlio_Adler',
      phone: '81996764688',
      cpf: '11622612426',
      companyId: 1,
      profileId: 1,
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
    { permission: 'subarea_inventarios', name: 'subarea', group: 'inventarios' },
    { permission: 'treinamentos', name: 'treinamentos', group: 'treinamentos' },
    { permission: 'certificados', name: 'certificados', group: 'treinamentos' },
    { permission: 'treinamentos_orcamentos', name: 'orcamentos', group: 'comercial' },
    { permission: 'servicos', name: 'servicos', group: 'servicos' },
    { permission: 'servicos_orcamentos', name: 'orcamentos', group: 'comercial' },
    { permission: 'ordens_de_servico', name: 'OS', group: 'servicos' },
    { permission: 'almox', name: 'almox', group: 'almox' },
    { permission: 'financeiro', name: 'financeiro', group: 'financeiro' },
    { permission: 'compras', name: 'compras', group: 'financeiro' },
    { permission: 'notas_fiscais', name: 'notas fiscais', group: 'financeiro' },
    { permission: 'produtos', name: 'produtos', group: 'produtos' },
    { permission: 'comercial', name: 'comercial', group: 'comercial' },
    { permission: 'produtos_orcamentos', name: 'orcamentos', group: 'comercial' },
    { permission: 'clientes', name: 'clientes', group: 'clientes' },
    { permission: 'user', name: 'user', group: 'user' },
    { permission: 'site', name: 'site', group: 'site' },
    { permission: 'servicos_site', name: 'servicos', group: 'site' },
    { permission: 'loja_site', name: 'loja', group: 'site' },
    { permission: 'profile', name: 'perfis', group: 'perfil' },
    { permission: 'instrutores', name: 'instrutores', group: 'treinamentos' },
    { permission: 'classes', name: 'turmas', group: 'treinamentos' },
    { permission: 'company', name: 'empresa', group: 'empresa' },
    { permission: 'integracoes', name: 'integracoes', group: 'integracoes' },
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
  // permissao personalizada para password
  permissionsData.push({
    name: 'update_user_password',
    description: 'Alterar senha de usuário',
    group: 'user',
  });

  // Inserção das permissões no banco de dados
  for (const permission of permissionsData) {
    const verifyExist = await prisma.permission.findUnique({
      where: {
        name: permission.name,
      },
    });
    if (!verifyExist) {
      await prisma.permission.create({
        data: permission,
      });
      console.info(`Permission ${permission.name} created successfully!`);
    }
  }

  console.log('Seed da tabela Permission executado com sucesso!');
}

// --------------------------------------------------------------------------------
async function seedSuperPermissions() {
  // Busca todas as permissões
  const permissions = await prisma.permission.findMany();

  if (!permissions || permissions.length === 0) {
    throw new Error(
      'Nenhuma permissão. Execute o seed de Permission primeiro.',
    );
  }

  // Associa cada permissão encontrada à profile com id 1
  for (const permission of permissions) {
    const verifyExist = await prisma.profilePermission.findUnique({
      where: {
        profileId_permissionId: {
          profileId: 1,
          permissionId: permission.id,
        },
      },
    });
    if (!verifyExist) {
      await prisma.profilePermission.create({
        data: {
          profileId: 1, // Profile de Super recebe todas as permissões
          permissionId: permission.id,
        },
      });
      console.info(`created: ProfilePermission ${permission.name} successfully for Super profile!`);
    } else {
      await prisma.profilePermission.update({
        where: {
          profileId_permissionId: {
            profileId: 1,
            permissionId: permission.id,
          },
        },
        data: {
          inactiveAt: null,
        },
      });
      console.info(`updated: ProfilePermission ${permission.name} successfully for Super profile!`);
    }
  }

  console.log('Seed da tabela ProfilePermission para o perfil de Super executado com sucesso!');
}

// objeto de configuraçao para definir quais seeds vao rodar
const seedConfig = {
  companies: false,
  products: false,
  ranks: false,
  domRoles: false,
  companyProducts: false,
  profiles: false,
  users: false,
  permissions: true,
  seedSuperPermissions: true,
};

// Executa as Seeds ----------------------------------------------------------------
async function main() {
  console.log('VAI RODAR AS SEEDS!')
  if (seedConfig.companies) await seedCompanies();
  if (seedConfig.products) await seedProducts();
  if (seedConfig.ranks) await seedRanks();
  if (seedConfig.domRoles) await seedDomRoles();
  if (seedConfig.companyProducts) await seedCompanyProducts();
  if (seedConfig.profiles) await seedProfiles();
  if (seedConfig.users) await seedUsers();
  if (seedConfig.permissions) await seedPermissions();
  if (seedConfig.seedSuperPermissions) await seedSuperPermissions();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
