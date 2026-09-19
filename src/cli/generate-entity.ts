#!/usr/bin/env ts-node

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { getDMMF } from '@prisma/internals';

// Interface para representar um campo do schema
interface SchemaField {
  name: string;
  type: string;
  isRequired: boolean;
  isOptional: boolean;
  isArray: boolean;
  isRelation: boolean;
  relationType?: string;
  defaultValue?: string;
  isId: boolean;
  isUnique: boolean;
  isUpdatedAt: boolean;
  isCreatedAt: boolean;
}

// Interface para representar um modelo do schema
interface SchemaModel {
  name: string;
  fields: SchemaField[];
}

// Função para criar interface de leitura
function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

// Função para fazer pergunta e aguardar resposta
function askQuestion(
  rl: readline.Interface,
  question: string,
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

// Função para parsear tempo com unidades para segundos
function parseTimeToSeconds(input: string): number | null {
  const match = input.match(/^(\d+)([smhd])?$/i);

  if (!match) {
    return null;
  }

  const value = parseInt(match[1]);
  const unit = match[2]?.toLowerCase() || 's';

  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 60 * 60;
    case 'd':
      return value * 60 * 60 * 24;
    default:
      return null;
  }
}

// Função para formatar segundos em uma string legível
function formatSecondsToReadable(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} segundos`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minuto${minutes > 1 ? 's' : ''}`;
  } else if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hora${hours > 1 ? 's' : ''}`;
  } else {
    const days = Math.floor(seconds / 86400);
    return `${days} dia${days > 1 ? 's' : ''}`;
  }
}

// Função para unificar todos os arquivos .prisma (generator/datasource do schema.prisma + modelos/enums dos demais)
function getUnifiedPrismaSchema(): string {
  const schemaDir = path.join(process.cwd(), 'prisma', 'schema');
  const files = fs
    .readdirSync(schemaDir)
    .filter((file) => file.endsWith('.prisma'));
  let generator = '';
  let datasource = '';
  let enums = '';
  let models = '';
  for (const file of files) {
    const content = fs.readFileSync(path.join(schemaDir, file), 'utf-8');
    if (file === 'schema.prisma') {
      // Extrai generator, datasource e enums
      const generatorMatch = content.match(/generator[\s\S]*?\}/g);
      const datasourceMatch = content.match(/datasource[\s\S]*?\}/g);
      const enumMatches = content.match(/enum\s+\w+\s*\{[\s\S]*?\}/g);
      if (generatorMatch) generator = generatorMatch.join('\n');
      if (datasourceMatch) datasource = datasourceMatch.join('\n');
      if (enumMatches) enums = enumMatches.join('\n');
    } else {
      // Adiciona modelos, enums, etc
      models += '\n' + content;
    }
  }
  return `${generator}\n${datasource}\n${enums}\n${models}`;
}

// Função para listar todos os modelos disponíveis no schema unificado
async function getPrismaModels(): Promise<string[]> {
  const unifiedSchema = getUnifiedPrismaSchema();
  // Log do schema unificado para debug
  // Salvar schema unificado em arquivo temporário para análise
  fs.writeFileSync('schema-unificado-debug.prisma', unifiedSchema);
  const dmmf = await getDMMF({ datamodel: unifiedSchema });
  // Log dos models encontrados (numerado)
  return dmmf.datamodel.models.map((model) => model.name);
}

// Função para ler e parsear um schema do Prisma usando o schema unificado
async function parsePrismaSchema(
  schemaName: string,
): Promise<SchemaModel | null> {
  const unifiedSchema = getUnifiedPrismaSchema();
  try {
    const dmmf = await getDMMF({ datamodel: unifiedSchema });
    const model = dmmf.datamodel.models.find(
      (m) =>
        m.name.toLowerCase() === schemaName.toLowerCase() ||
        m.name.toLowerCase().replace(/_/g, '') ===
          schemaName.toLowerCase().replace(/_/g, ''),
    );
    if (!model) {
      console.error(`Modelo não encontrado no schema: ${schemaName}`);
      return null;
    }
    const fields: SchemaField[] = model.fields.map((field) => {
      const isArray = field.kind === 'object' && field.isList;
      const isRelation = field.kind === 'object';
      const isOptional = !field.isRequired;
      const isRequired = field.isRequired;
      const isId = field.isId;
      const isUnique = field.isUnique;
      const isUpdatedAt = field.isUpdatedAt;
      const isCreatedAt =
        field.hasDefaultValue &&
        field.default &&
        typeof field.default === 'object' &&
        'name' in field.default &&
        field.default.name === 'now';
      return {
        name: field.name,
        type: field.type,
        isRequired,
        isOptional,
        isArray,
        isRelation,
        relationType: isRelation ? field.type : undefined,
        defaultValue:
          field.hasDefaultValue && field.default
            ? typeof field.default === 'string'
              ? field.default
              : JSON.stringify(field.default)
            : undefined,
        isId,
        isUnique,
        isUpdatedAt,
        isCreatedAt,
      };
    });
    return {
      name: model.name,
      fields,
    };
  } catch (error) {
    console.error('Erro ao parsear schema:', error);
    return null;
  }
}

// Função para mapear tipos do Prisma para TypeScript
function mapPrismaTypeToTypeScript(prismaType: string): string {
  const typeMap: { [key: string]: string } = {
    String: 'string',
    Int: 'number',
    Float: 'number',
    Boolean: 'boolean',
    DateTime: 'Date',
    Json: 'JSON',
    BigInt: 'number',
    Decimal: 'number',
  };

  return typeMap[prismaType] || 'string';
}

// Função para mapear tipos do Prisma para validadores
function getValidatorsForType(
  prismaType: string,
  field: SchemaField,
  isCreateDTO: boolean = false,
): string[] {
  const validators: string[] = [];

  switch (prismaType) {
    case 'String':
      validators.push('@IsString()');
      break;
    case 'Int':
    case 'BigInt':
      validators.push('@IsInt()');
      validators.push('@Type(() => Number)');
      break;
    case 'Float':
    case 'Decimal':
      validators.push('@IsNumber()');
      validators.push('@Type(() => Number)');
      break;
    case 'Boolean':
      validators.push('@IsBoolean()');
      validators.push(`@Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })`);
      break;
    case 'DateTime':
      validators.push('@IsDate()');
      validators.push('@Type(() => Date)');
      break;
    case 'Json':
      validators.push('@IsJSON()');
      break;
    default:
      validators.push('@IsString()');
  }

  // Tornar companyId opcional no CreateDTO pois virá do token
  if (field.name === 'companyId' && isCreateDTO) {
    validators.push('@IsOptional()');
  }
  // Adicionar validador de obrigatoriedade
  else if (field.isRequired && !field.isId) {
    validators.push(`@IsNotEmpty({ message: '${field.name} is required' })`);
  } else if (field.isOptional || field.isId) {
    validators.push('@IsOptional()');
  }

  // Validadores específicos
  if (field.name.toLowerCase().includes('email')) {
    validators.push("@IsEmail({}, { message: 'Invalid email format' })");
  } else if (field.name.toLowerCase().includes('url')) {
    validators.push("@IsUrl({}, { message: 'Invalid URL format' })");
  }

  return validators;
}

// Função para determinar se um campo deve ser incluído no DTO
function shouldIncludeFieldInDTO(
  field: SchemaField,
  isCreateDTO: boolean,
): boolean {
  // Sempre incluir campos não-relacionais
  if (!field.isRelation) {
    // No DTO de criação, não incluir campos auto-gerados
    if (isCreateDTO && (field.isId || field.isCreatedAt || field.isUpdatedAt)) {
      return false;
    }
    return true;
  }

  // Para campos relacionais, incluir apenas IDs
  return field.name.toLowerCase().endsWith('id');
}

// Função para gerar regras de emptyUpdates baseadas nos campos booleanos
function generateEmptyUpdatesRules(schemaModel: SchemaModel): string {
  const booleanFields = schemaModel.fields.filter(
    (field) =>
      field.type === 'Boolean' &&
      field.name !== 'active' &&
      field.name !== 'status',
  );

  let rules = '';

  if (booleanFields.length > 0) {
    rules += '  // Campos booleanos detectados automaticamente\n';
    booleanFields.forEach((field) => {
      rules += `  if (UpdateDto.${field.name} === undefined) UpdateDto.${field.name} = false;\n`;
    });
    rules += '\n';
  }

  return rules;
}

// Função para gerar omitAttributes baseado no schema
function generateOmitAttributes(schemaModel: SchemaModel): string {
  const sensitiveFields = schemaModel.fields.filter((field) => {
    const fieldName = field.name.toLowerCase();
    return (
      fieldName.includes('password') ||
      fieldName.includes('token') ||
      fieldName.includes('secret') ||
      fieldName.includes('key') ||
      fieldName.includes('hash') ||
      fieldName.includes('salt') ||
      fieldName.includes('credential') ||
      fieldName.includes('auth')
    );
  });

  if (sensitiveFields.length > 0) {
    const fieldNames = sensitiveFields
      .map((field) => `'${field.name}'`)
      .join(', ');
    return `export const omitAttributes = [${fieldNames}];`;
  }

  return `export const omitAttributes: string[] = [];`;
}

// Função para verificar se a entidade já existe
function checkEntityExists(
  featureName: string,
  isGroup: boolean,
  groupName: string,
): boolean {
  const entityName = featureName.toLowerCase();
  let entityDir = '';

  if (isGroup) {
    entityDir = path.join(
      process.cwd(),
      'src',
      'features',
      groupName,
      entityName,
    );
  } else {
    entityDir = path.join(process.cwd(), 'src', 'features', entityName);
  }

  return fs.existsSync(entityDir);
}

// Função para listar entidades existentes em um grupo
function listExistingEntitiesInGroup(groupName: string): string[] {
  const groupDir = path.join(process.cwd(), 'src', 'features', groupName);
  if (!fs.existsSync(groupDir)) {
    return [];
  }

  return fs
    .readdirSync(groupDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
}

// Função para listar entidades existentes na raiz
function listExistingEntitiesInRoot(): string[] {
  const featuresDir = path.join(process.cwd(), 'src', 'features');
  if (!fs.existsSync(featuresDir)) {
    return [];
  }

  return fs
    .readdirSync(featuresDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
}

// Função principal interativa
async function main() {
  const rl = createInterface();

  try {
    // 0. Perguntar se pertence a um grupo
    const isGroupAnswer = await askQuestion(
      rl,
      'A entidade pertence a um grupo? (s/n): ',
    );
    const isGroup =
      isGroupAnswer.toLowerCase() === 's' ||
      isGroupAnswer.toLowerCase() === 'sim';
    let groupName = '';
    if (isGroup) {
      groupName = await askQuestion(
        rl,
        'Qual o nome do grupo? (ex: clientes): ',
      );
      if (!groupName) {
        console.error('❌ Nome do grupo é obrigatório');
        process.exit(1);
      }
    }

    // 1. Perguntar nome da feature
    const featureName = await askQuestion(
      rl,
      'Digite o nome da feature (ex: user, product): ',
    );

    if (!featureName) {
      console.error('❌ Nome da feature é obrigatório');
      process.exit(1);
    }

    // 2. Perguntar nome da rota
    const routeName = await askQuestion(
      rl,
      'Digite o nome da rota (ex: users, products): ',
    );

    if (!routeName) {
      console.error('❌ Nome da rota é obrigatório');
      process.exit(1);
    }

    // 3. Perguntar nome da permission
    const permissionName = await askQuestion(
      rl,
      'Digite o nome da permission (ex: users, products): ',
    );

    if (!permissionName) {
      console.error('❌ Nome da permission é obrigatório');
      process.exit(1);
    }

    // 4. Verificar se a entidade já existe
    const entityExists = checkEntityExists(featureName, isGroup, groupName);
    if (entityExists) {
      console.error(`\n❌ Erro: A entidade "${featureName}" já existe!`);

      if (isGroup) {
        console.log(`\n📁 Entidades existentes no grupo "${groupName}":`);
        const existingEntities = listExistingEntitiesInGroup(groupName);
        existingEntities.forEach((entity, index) => {
          console.log(`   ${index + 1}. 📄 ${entity}`);
        });
      } else {
        console.log(`\n📁 Entidades existentes na raiz:`);
        const existingEntities = listExistingEntitiesInRoot();
        existingEntities.forEach((entity, index) => {
          console.log(`   ${index + 1}. 📄 ${entity}`);
        });
      }

      console.log(
        '\n💡 Dica: Use um nome diferente para a feature ou remova a entidade existente.',
      );
      process.exit(1);
    }

    // 5. Listar modelos disponíveis no schema unificado
    console.log('\n🔍 Carregando modelos disponíveis...');
    const availableModels = await getPrismaModels();

    // 6. Perguntar nome do modelo
    console.log('\n📋 Modelos disponíveis:');
    availableModels.forEach((model, index) => {
      console.log(`   ${index + 1}. 🗃️  ${model}`);
    });

    const modelNameInput = await askQuestion(
      rl,
      '\n🗃️  Digite o nome do modelo (ou número da lista): ',
    );

    let selectedModel = modelNameInput;

    // Se foi digitado um número, converter para nome do modelo
    const modelIndex = parseInt(modelNameInput) - 1;
    if (
      !isNaN(modelIndex) &&
      modelIndex >= 0 &&
      modelIndex < availableModels.length
    ) {
      selectedModel = availableModels[modelIndex];
    }

    // 7. Ler e parsear o modelo
    console.log(`\n🔍 Analisando modelo "${selectedModel}"...`);
    const schemaModel = await parsePrismaSchema(selectedModel);

    if (!schemaModel) {
      console.error(`❌ Erro ao ler o modelo "${selectedModel}"`);
      process.exit(1);
    }

    // 8. Perguntar se quer incluir campo de imagem
    const hasImageAnswer = await askQuestion(
      rl,
      '\n🖼️  Deseja incluir campo de imagem? (s/n): ',
    );
    const hasImage =
      hasImageAnswer.toLowerCase() === 's' ||
      hasImageAnswer.toLowerCase() === 'sim';

    // 8.1. Se quer imagem, perguntar se quer usar otimizador WebP
    let useWebpOptimizer = false;
    if (hasImage) {
      const webpAnswer = await askQuestion(
        rl,
        '🌐 Deseja usar otimizador de imagens WebP? (s/n): ',
      );
      useWebpOptimizer =
        webpAnswer.toLowerCase() === 's' || webpAnswer.toLowerCase() === 'sim';
    }

    // 9. Perguntar valor de noCompany
    const noCompanyAnswer = await askQuestion(
      rl,
      '🏢 A rota exige companyId do token? (s/n)\n(S = noCompany = false, N = noCompany = true): ',
    );
    const noCompany =
      noCompanyAnswer.toLowerCase() === 'n' ||
      noCompanyAnswer.toLowerCase() === 'não' ||
      noCompanyAnswer.toLowerCase() === 'nao';

    // 10. Perguntar sobre upsert
    const hasUpsertAnswer = await askQuestion(
      rl,
      '\n🔄 Deseja incluir rota de upsert? (s/n): ',
    );
    const hasUpsert =
      hasUpsertAnswer.toLowerCase() === 's' ||
      hasUpsertAnswer.toLowerCase() === 'sim';

    // 11. Perguntar sobre cache
    const useCacheAnswer = await askQuestion(
      rl,
      '\n💾 Deseja usar cache nas rotas? (s/n): ',
    );
    const useCache =
      useCacheAnswer.toLowerCase() === 's' ||
      useCacheAnswer.toLowerCase() === 'sim';

    let cacheTTLSeconds = 3600; // padrão 1 hora em segundos
    if (useCache) {
      let validTime = false;
      while (!validTime) {
        const cacheTTLAnswer = await askQuestion(
          rl,
          '⏱️  Por quanto tempo deseja manter o cache?\n' +
            '   Exemplos: 300s (5 minutos), 5m, 1h, 24h, 7d\n' +
            '   Digite o tempo: ',
        );

        if (!cacheTTLAnswer) {
          // Se vazio, usar padrão
          cacheTTLSeconds = 3600;
          validTime = true;
        } else {
          const parsedSeconds = parseTimeToSeconds(cacheTTLAnswer);
          if (parsedSeconds !== null && parsedSeconds > 0) {
            cacheTTLSeconds = parsedSeconds;
            validTime = true;
          } else {
            console.error(
              '\n❌ Entrada inválida! Use o formato: número + unidade (s/m/h/d)',
            );
            console.log('   Exemplos válidos: 30s, 5m, 2h, 1d');
          }
        }
      }
      console.log(
        `\n✅ Cache configurado para ${formatSecondsToReadable(cacheTTLSeconds)}`,
      );
    }

    // 12. Mostrar campos que serão incluídos nos DTOs
    console.log('\n📝 Campos que serão incluídos nos DTOs:');

    console.log('\n✅ DTO de Criação (CreateDto):');
    const createFields = schemaModel.fields.filter((field) =>
      shouldIncludeFieldInDTO(field, true),
    );
    createFields.forEach((field) => {
      console.log(
        `   📄 ${field.name}: ${field.type}${field.isOptional ? '?' : ''}`,
      );
    });
    if (hasImage) {
      console.log('   🖼️  image?: any');
    }

    console.log('\n🔄 DTO de Atualização (UpdateDto):');
    const updateFields = schemaModel.fields.filter((field) =>
      shouldIncludeFieldInDTO(field, false),
    );
    updateFields.forEach((field) => {
      console.log(
        `   📄 ${field.name}?: ${mapPrismaTypeToTypeScript(field.type)}`,
      );
    });
    if (hasImage) {
      console.log('   🖼️  image?: any');
    }

    // 13. Confirmar geração
    console.log('\n' + '='.repeat(50));
    console.log('🚀 RESUMO DA GERAÇÃO');
    console.log('='.repeat(50));
    console.log(`📁 Feature: ${featureName}`);
    console.log(`🌐 Rota: /${routeName}`);
    console.log(`🔐 Permission: ${permissionName}`);
    console.log(`🗃️  Modelo: ${selectedModel}`);
    console.log(`🖼️  Imagem: ${hasImage ? 'Sim' : 'Não'}`);
    if (hasImage) {
      console.log(`🌐 Otimizador WebP: ${useWebpOptimizer ? 'Sim' : 'Não'}`);
    }
    console.log(`🏢 CompanyId: ${noCompany ? 'Não exige' : 'Exige'}`);
    console.log(`🔄 Upsert: ${hasUpsert ? 'Sim' : 'Não'}`);
    console.log(
      `💾 Cache: ${useCache ? `Sim (${formatSecondsToReadable(cacheTTLSeconds)})` : 'Não'}`,
    );
    console.log(
      `📊 Campos: ${createFields.length} no CreateDto, ${updateFields.length} no UpdateDto`,
    );
    console.log('='.repeat(50));

    const answer = await askQuestion(
      rl,
      '\n✅ Deseja gerar a entidade com essas configurações? (s/n): ',
    );

    if (answer.toLowerCase() !== 's') {
      console.log('\n❌ Geração cancelada pelo usuário.');
      rl.close();
      return;
    }

    // 14. Gerar a entidade
    console.log('\n🚀 Iniciando geração da entidade...');
    await generateEntity(
      featureName,
      selectedModel,
      schemaModel,
      hasImage,
      useWebpOptimizer,
      noCompany,
      isGroup,
      groupName,
      routeName,
      permissionName,
      hasUpsert,
      useCache,
      cacheTTLSeconds,
    );
  } catch (error) {
    console.error('❌ Erro:', error);
  } finally {
    rl.close();
  }
}

// Função para gerar a entidade
async function generateEntity(
  featureName: string,
  schemaName: string,
  schemaModel: SchemaModel,
  hasImage: boolean,
  useWebpOptimizer: boolean,
  noCompany: boolean,
  isGroup: boolean,
  groupName: string,
  routeName: string,
  permissionName: string,
  hasUpsert: boolean,
  useCache: boolean,
  cacheTTLSeconds: number,
) {
  // Format entity name
  const entityName = featureName.toLowerCase();
  const entityNamePascal = toPascalCase(entityName);
  const entityNamePlural = routeName;

  // Definir diretório base
  let entityDir = '';
  let uploadImportPath = '';
  if (isGroup) {
    // Se o grupo não existir, criar pasta
    const groupDir = path.join(process.cwd(), 'src', 'features', groupName);
    if (!fs.existsSync(groupDir)) {
      fs.mkdirSync(groupDir, { recursive: true });
    }
    entityDir = path.join(
      process.cwd(),
      'src',
      'features',
      groupName,
      entityName,
    );
    uploadImportPath = '../../upload/upload.middleware';
  } else {
    entityDir = path.join(process.cwd(), 'src', 'features', entityName);
    uploadImportPath = '../upload/upload.middleware';
  }

  const dtoDir = path.join(entityDir, 'dto');
  const interfacesDir = path.join(entityDir, 'interfaces');

  // Create directories if they don't exist
  if (!fs.existsSync(entityDir)) {
    fs.mkdirSync(entityDir, { recursive: true });
  }
  if (!fs.existsSync(dtoDir)) {
    fs.mkdirSync(dtoDir, { recursive: true });
  }
  if (!fs.existsSync(interfacesDir)) {
    fs.mkdirSync(interfacesDir, { recursive: true });
  }

  // Gerar associations.ts
  const associationsContent = `export const paramsIncludes = {
  // Configure aqui os relacionamentos que devem ser incluídos nas consultas
  // Exemplo: 'user': true,
  // Exemplo: 'company': { select: { id: true, name: true } },
};
`;

  // Gerar rules.ts
  const rulesContent = `import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';
 
export const noCompany = ${noCompany};
${generateOmitAttributes(schemaModel)}


/*
 * Função de search personalizada para verificação antes de criar
 * Crie com os parametros de busca pré-criaão
 */
export function validateCreate(request: Request, CreateDto: any) {
  // Exemplo de search usando companyId do request e campos do dto
  // PERSONALIZE ESTA FUNÇÃO conforme as necessidades da sua entidade
  const search = {
    companyId: Number(request.user?.companyId),
    // Adicione aqui os campos que devem ser únicos por empresa
    // Exemplo: name: CreateDto.name,
    // Exemplo: email: CreateDto.email,
  };
  
  return search;
}

/*
 * Função para formatar campos pré-update
 * ajustes valores para update
 * ajuste valores null/booleab para quando vierem vazios
 */
export function formaterPreUpdate(UpdateDto: any) {
  // Regras automáticas para campos booleanos (geradas automaticamente)
  // PERSONALIZE ESTA FUNÇÃO conforme as necessidades da sua entidade
  
  ${generateEmptyUpdatesRules(schemaModel)}
  
  // Exemplos de outros tipos de campos
  // if (UpdateDto.numberField === undefined) UpdateDto.numberField = 0;
  // if (UpdateDto.arrayField === undefined) UpdateDto.arrayField = [];
  // if (UpdateDto.objectField === undefined) UpdateDto.objectField = {};
  
  return UpdateDto;
}${
    hasUpsert
      ? `

/*
 * Função para definir whereCondition do upsert
 * Define campos únicos para identificar registro existente
 */
export function getUpsertWhereCondition(request: Request, dto: any) {
  // PERSONALIZE ESTA FUNÇÃO conforme as necessidades da sua entidade
  // Defina os campos únicos para identificar registros existentes
  
  return {
    companyId: Number(request.user?.companyId),
    // Adicione aqui o campo único ou combinação de campos
    // Exemplo: email: dto.email,
    // Exemplo: code: dto.code,
    // Para unicidade composta, use:
    // AND: [
    //   { companyId: Number(request.user?.companyId) },
    //   { fieldName: dto.fieldName }
    // ]
  };
}`
      : ''
  }

// HOOKS DE PRÉ E PÓS CREATE/UPDATE

/*
 * Hook de pré criação
 */
async function hookPreCreate(params: { 
  dto: any; 
  entity: any; 
  prisma: PrismaService; 
  logParams: any 
}) {
  const { dto, entity } = params;
  // Personalize aqui se necessário
}

/*
 * Hook de pós criação
 */
async function hookPosCreate(
  params: { 
    dto: any; 
    entity: any; 
    prisma: PrismaService; 
    logParams: any 
  },
  created: any
) {
  const { dto, entity } = params;
  // Personalize aqui se necessário
}

/*
 * Hook de pré update
 */
async function hookPreUpdate(params: { 
  id: number; 
  dto: any; 
  entity: any; 
  prisma: PrismaService; 
  logParams: any 
}) {
  const { id, dto, entity } = params;
  // Personalize aqui se necessário
}

/*
 * Hook de pós update
 */
async function hookPosUpdate(
  params: { 
    id: number; 
    dto: any; 
    entity: any; 
    prisma: PrismaService; 
    logParams: any 
  }, 
  updated: any
) {
  const { id, dto, entity } = params;
  // Personalize aqui se necessário
}

export const hooksCreate = {
  hookPreCreate,
  hookPosCreate,
};

export const hooksUpdate = {
  hookPreUpdate,
  hookPosUpdate,
};${
    hasUpsert
      ? `

/*
 * Hook de pré upsert
 */
async function hookPreUpsert(params: { 
  id: number;
  dto: any; 
  entity: any; 
  prisma: PrismaService; 
  logParams: any 
}) {
  const { id, dto, entity } = params;
  // Personalize aqui se necessário
}

/*
 * Hook de pós upsert
 */
async function hookPosUpsert(
  params: { 
    id: number;
    dto: any; 
    entity: any; 
    prisma: PrismaService; 
    logParams: any 
  }, 
  upserted: any
) {
  const { id, dto, entity } = params;
  // Personalize aqui se necessário
}

export const hooksUpsert = {
  hookPreUpsert,
  hookPosUpsert,
};`
      : ''
  }
`;

  // Generate service.ts
  const serviceContent = `import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';

@Injectable()
export class ${entityNamePascal}Service extends GenericService<
  CreateDto,
  UpdateDto,
  IEntity
> {
  constructor(
    protected prisma: PrismaService,
    protected uploadService: UploadService,
  ) {
    super(prisma, uploadService);
  }

  /**
   * Método específico customizado
   */
  // async customMethod(params: any): Promise<IEntity | null> {
  //   try {
  //     const result = await this.prisma.selectOne('modelName', {
  //       where: {
  //         id: Number(params.id),
  //       },
  //     });
  //   } catch (error) {
  //     throw new BadRequestException(error);
  //   }
  // }
}
`;

  // Generate controller.ts
  const cacheKeyPrefix = entityNamePlural.replace(/[_\s]/g, '-');
  const cacheReadableTime = formatSecondsToReadable(cacheTTLSeconds);
  const cacheDecorator = useCache
    ? `@Cache({ prefix: '${cacheKeyPrefix}', ttl: ${cacheTTLSeconds} })`
    : `// @Cache({ prefix: '${cacheKeyPrefix}', ttl: ${cacheTTLSeconds} }) // descomente para usar cache (${cacheReadableTime})`;
  const cacheEvictDecorator = useCache
    ? `@CacheEvictAll('${cacheKeyPrefix}:*', 'cache:*/${cacheKeyPrefix}*')`
    : `// @CacheEvictAll('${cacheKeyPrefix}:*', 'cache:*/${cacheKeyPrefix}*') // descomente para limpar cache`;

  // Definir interceptors - sempre usa FormData
  let fileInterceptorImport = '';
  let fileInterceptorUsage = '';

  if (hasImage && useWebpOptimizer) {
    fileInterceptorImport = `import { getOptimizedMulterOptions } from '${uploadImportPath}';
import { ImageOptimizationInterceptor } from '${isGroup ? '../../' : '../'}upload/image-optimization.interceptor';`;
    fileInterceptorUsage = `FileInterceptor('image', getOptimizedMulterOptions()),
    ImageOptimizationInterceptor,`;
  } else if (hasImage) {
    fileInterceptorImport = `import { getMulterOptions } from '${uploadImportPath}';`;
    fileInterceptorUsage = `FileInterceptor('image', getMulterOptions('${entityName}-image')),`;
  } else {
    // Mesmo sem imagem, sempre usa FileInterceptor para processar FormData
    fileInterceptorImport = ``;
    fileInterceptorUsage = `FileInterceptor('file'),`; // campo 'file' vazio para processar FormData
  }

  const controllerContent = `import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
  Query,
  applyDecorators,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
// Import entity template
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { IEntity } from './interfaces/interface';
import { ${entityNamePascal}Service as Service } from './service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';
${fileInterceptorImport}
// Import generic controller
import { GenericController } from 'src/features/generic/generic.controller';
import { Public } from 'src/auth/decorators/public.decorator';
// Import cache
import { Cache, CacheEvictAll } from 'src/common/cache';
import { CacheService } from 'src/common/cache/cache.service';
// Import de configuraões
import { paramsIncludes } from './associations';
import {
  noCompany,
  validateCreate,
  formaterPreUpdate,
  omitAttributes,
  hooksCreate,
  hooksUpdate,${
    hasUpsert
      ? `
  getUpsertWhereCondition,
  hooksUpsert,`
      : ''
  }
} from './rules';

function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: '${schemaModel.name}' as keyof PrismaClient,
  name: '${entityNamePascal}',
  route: '${entityNamePlural}',
  permission: '${permissionName}',
};

@Controller(entity.route)
export class ${entityNamePascal}Controller extends GenericController<
  CreateDto,
  UpdateDto,
  IEntity,
  Service
> {
  constructor(
    private readonly Service: Service,
    // cacheService é usado pelos decorators de cache
    private readonly cacheService: CacheService,
  ) {
    super(Service, entity);
  }

  @UserPermission(\`list_\${entity.permission}\`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  ${cacheDecorator}
  @Get()
  async get(@Req() request: Request, @Query() query: any) {
    // Adiciona omitAttributes aos filtros se não estiver presente
    // Sempre do servidor: o cliente não escolhe o que omitir (senão
      // ?omitAttributes[]=id devolveria hash de senha e sellerConfig).
      query.omitAttributes = omitAttributes;
    return super.get(request, query, paramsIncludes, noCompany);
  }

  @UserPermission(\`create_\${entity.permission}\`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  ${cacheEvictDecorator}
  @Post()
  @UseInterceptors(
    ${fileInterceptorUsage}
  )
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async create(
    @Req() request: Request,
    @Body() CreateDto: CreateDto,
    ${hasImage ? '@UploadedFile() file?: Express.MulterS3.File,' : ''}
  ) {
    ${
      hasImage && useWebpOptimizer
        ? `// Se há arquivo, adiciona a URL ao DTO
    if (file && file.location) {
      CreateDto.imageUrl = file.location;
    }`
        : ''
    }
    const search = validateCreate(request, CreateDto);
    return super.create(request, CreateDto, ${hasImage ? 'file' : 'null'}, search, hooksCreate);
  }

  @UserPermission(\`update_\${entity.permission}\`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  ${cacheEvictDecorator}
  @Put(':id')
  @UseInterceptors(
    ${fileInterceptorUsage}
  )
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async update(
    @Param('id') id: number,
    @Req() request: Request,
    @Body() UpdateDto: UpdateDto,
    ${hasImage ? '@UploadedFile() file?: Express.MulterS3.File,' : ''}
  ) {
    ${
      hasImage && useWebpOptimizer
        ? `// Se há arquivo, adiciona a URL ao DTO
    if (file && file.location) {
      UpdateDto.imageUrl = file.location;
    }`
        : ''
    }
    const processedDto = formaterPreUpdate(UpdateDto);
    return super.update(id, request, processedDto, ${hasImage ? 'file' : 'null'}, hooksUpdate);
  }

  @UserPermission(\`activate_\${entity.permission}\`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  ${cacheEvictDecorator}
  @Patch('active/:id')
  async activate(@Param('id') id: number, @Req() request: Request) {
    return super.activate(id, request);
  }

  @UserPermission(\`inactive_\${entity.permission}\`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  ${cacheEvictDecorator}
  @Patch('inactive/:id')
  async inactivate(@Param('id') id: number, @Req() request: Request) {
    return super.inactivate(id, request);
  }${
    hasUpsert
      ? `

  @UserPermission(\`create_\${entity.permission}\`) // mesma permissao do create
  // @Public() // descomente para tornar publica
  ${cacheEvictDecorator}
  @Post('upsert')
  @UseInterceptors(
    ${fileInterceptorUsage}
  )
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async upsert(
    @Req() request: Request,
    @Body() upsertDto: CreateDto,
    ${hasImage ? '@UploadedFile() file?: Express.MulterS3.File,' : ''}
  ) {
    ${
      hasImage && useWebpOptimizer
        ? `// Se há arquivo, adiciona a URL ao DTO
    if (file && file.location) {
      upsertDto.imageUrl = file.location;
    }`
        : ''
    }
    const whereCondition = getUpsertWhereCondition(request, upsertDto);
    
    return super.upsert(request, upsertDto, ${hasImage ? 'file' : 'null'}, whereCondition, hooksUpsert);
  }`
      : ''
  }
}
`;

  // Generate module.ts
  const uploadModulePath = isGroup
    ? '../../upload/upload.module'
    : '../upload/upload.module';
  const moduleContent = `import { Module } from '@nestjs/common';
import { ${entityNamePascal}Controller as Controller } from './controller';
import { ${entityNamePascal}Service as Service } from './service';
import { UploadModule } from '${uploadModulePath}';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class ${entityNamePascal}Module {}
`;

  // Generate create.dto.ts
  let createDtoContent = `import { Type, Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  IsNotEmpty,
  IsInt,
  IsOptional,
  IsUrl,
  IsBoolean,
  IsNumber,
  IsDate,
  IsJSON,
} from 'class-validator';

export class CreateDto {
`;

  // Adicionar campos do schema
  const createFields = schemaModel.fields.filter((field) =>
    shouldIncludeFieldInDTO(field, true),
  );
  createFields.forEach((field) => {
    const validators = getValidatorsForType(field.type, field, true); // passar true para isCreateDTO
    const tsType = mapPrismaTypeToTypeScript(field.type);

    // Se for companyId, tornar opcional no tipo também
    const isOptionalField = field.isOptional || field.name === 'companyId';

    createDtoContent += `
  ${validators.join('\n  ')}
  ${field.name}${isOptionalField ? '?' : ''}: ${tsType};
`;
  });

  // Adicionar campo de imagem se necessário
  if (hasImage) {
    createDtoContent += `
  @IsOptional()
  image?: any;
`;
  }

  createDtoContent += `}
`;

  // Generate update.dto.ts
  let updateDtoContent = `import { Type, Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  IsInt,
  IsOptional,
  IsUrl,
  IsBoolean,
  IsNumber,
  IsDate,
  IsJSON,
} from 'class-validator';

export class UpdateDto {
`;

  // Adicionar campos do schema
  const updateFields = schemaModel.fields.filter((field) =>
    shouldIncludeFieldInDTO(field, false),
  );
  updateFields.forEach((field) => {
    // Sempre @IsOptional() no update
    const validators = getValidatorsForType(field.type, {
      ...field,
      isOptional: true,
      isRequired: false,
    }).filter(
      (v) => v !== `@IsNotEmpty({ message: '${field.name} is required' })`,
    );
    const tsType = mapPrismaTypeToTypeScript(field.type);

    updateDtoContent += `
  ${validators.join('\n  ')}
  ${field.name}?: ${tsType};
`;
  });

  // Adicionar campo de imagem se necessário
  if (hasImage) {
    updateDtoContent += `
  @IsOptional()
  image?: any;
`;
  }

  updateDtoContent += `}
`;

  // Generate interface.ts
  const interfaceContent = `/* eslint-disable */
import { ${schemaModel.name} as Prisma } from '@prisma/client';

export interface IEntity extends Prisma {
  // Add relations here as needed
}

// Tipos auxiliares
`;

  // Write files
  console.log('\n📁 Criando estrutura de diretórios...');
  fs.writeFileSync(path.join(entityDir, 'service.ts'), serviceContent);
  console.log('   ✅ service.ts criado');
  fs.writeFileSync(path.join(entityDir, 'controller.ts'), controllerContent);
  console.log('   ✅ controller.ts criado');
  fs.writeFileSync(path.join(entityDir, 'module.ts'), moduleContent);
  console.log('   ✅ module.ts criado');
  fs.writeFileSync(path.join(dtoDir, 'create.dto.ts'), createDtoContent);
  console.log('   ✅ create.dto.ts criado');
  fs.writeFileSync(path.join(dtoDir, 'update.dto.ts'), updateDtoContent);
  console.log('   ✅ update.dto.ts criado');
  fs.writeFileSync(path.join(interfacesDir, 'interface.ts'), interfaceContent);
  console.log('   ✅ interface.ts criado');
  fs.writeFileSync(
    path.join(entityDir, 'associations.ts'),
    associationsContent,
  );
  console.log('   ✅ associations.ts criado');
  fs.writeFileSync(path.join(entityDir, 'rules.ts'), rulesContent);
  console.log('   ✅ rules.ts criado');

  // Mensagem de sucesso e próximos passos
  console.log('\n🎉 Entidade gerada com sucesso!');
  console.log('\n📋 PRÓXIMOS PASSOS:');
  console.log(
    '\n1️⃣  Importe o módulo gerado no app.module.ts para ativar a rota:',
  );
  if (groupName) {
    console.log(
      `   📝 import { ${toPascalCase(featureName)}Module } from './features/${groupName}/${entityName}/module';`,
    );
  } else {
    console.log(
      `   📝 import { ${toPascalCase(featureName)}Module } from './features/${entityName}/module';`,
    );
  }
  console.log('\n2️⃣  Configure os arquivos gerados:');
  console.log(
    '   🔍 Ajuste a função validateCreate em rules.ts para definir os critérios de unicidade',
  );
  console.log(
    '   ⚙️  Personalize os hooks conforme necessário para lógicas específicas',
  );
  console.log(
    '   🔗 Configure paramsIncludes em associations.ts para relacionamentos',
  );
  console.log(
    '   🔄 Ajuste a função formaterPreUpdate em rules.ts para processar campos vazios/falsos no update',
  );
  console.log(
    '   🔒 Configure omitAttributes em rules.ts para campos sensíveis que devem ser omitidos nas consultas',
  );
  console.log('\n✨ Sua entidade está pronta para uso!');
}

// Funções auxiliares
function toPascalCase(entityName: string): string {
  if (entityName.includes('_')) {
    return entityName
      .split('_')
      .map(
        (word: string) =>
          word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
      )
      .join('');
  } else {
    return entityName.charAt(0).toUpperCase() + entityName.slice(1);
  }
}

// Executar se for o arquivo principal
if (require.main === module) {
  main().catch(console.error);
}
