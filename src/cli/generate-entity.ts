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

// Função para unificar todos os arquivos .prisma (generator/datasource do schema.prisma + modelos/enums dos demais)
function getUnifiedPrismaSchema(): string {
  const schemaDir = path.join(process.cwd(), 'prisma', 'schema');
  const files = fs
    .readdirSync(schemaDir)
    .filter((file) => file.endsWith('.prisma'));
  let generator = '';
  let datasource = '';
  let models = '';
  for (const file of files) {
    const content = fs.readFileSync(path.join(schemaDir, file), 'utf-8');
    if (file === 'schema.prisma') {
      // Extrai apenas generator e datasource
      const generatorMatch = content.match(/generator[\s\S]*?\}/g);
      const datasourceMatch = content.match(/datasource[\s\S]*?\}/g);
      if (generatorMatch) generator = generatorMatch.join('\n');
      if (datasourceMatch) datasource = datasourceMatch.join('\n');
    } else {
      // Adiciona modelos, enums, etc
      models += '\n' + content;
    }
  }
  return `${generator}\n${datasource}\n${models}`;
}

// Função para listar todos os modelos disponíveis no schema unificado
async function getPrismaModels(): Promise<string[]> {
  const unifiedSchema = getUnifiedPrismaSchema();
  // Log do schema unificado para debug
  console.log('--- SCHEMA UNIFICADO ---\n', unifiedSchema);
  // Salvar schema unificado em arquivo temporário para análise
  fs.writeFileSync('schema-unificado-debug.prisma', unifiedSchema);
  const dmmf = await getDMMF({ datamodel: unifiedSchema });
  // Log dos models encontrados (numerado)
  console.log('Modelos encontrados:');
  dmmf.datamodel.models.forEach((m, idx) => {
    console.log(`  ${idx + 1}. ${m.name}`);
  });
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
      validators.push('@Type(() => Boolean)');
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

  // Adicionar validador de obrigatoriedade
  if (field.isRequired && !field.isId) {
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

    // 2. Listar modelos disponíveis no schema unificado
    const availableModels = await getPrismaModels();

    // 3. Perguntar nome do modelo
    const modelNameInput = await askQuestion(
      rl,
      '\nDigite o nome do modelo (ou número da lista): ',
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

    // 4. Ler e parsear o modelo
    const schemaModel = await parsePrismaSchema(selectedModel);

    if (!schemaModel) {
      console.error(`❌ Erro ao ler o modelo "${selectedModel}"`);
      process.exit(1);
    }

    // 5. Perguntar se quer incluir campo de imagem
    const hasImageAnswer = await askQuestion(
      rl,
      '\nDeseja incluir campo de imagem? (s/n): ',
    );
    const hasImage =
      hasImageAnswer.toLowerCase() === 's' ||
      hasImageAnswer.toLowerCase() === 'sim';

    // 6. Perguntar valor de noCompany
    const noCompanyAnswer = await askQuestion(
      rl,
      'A rota exige companyId do token? (s/n)\n(S = noCompany = false, N = noCompany = true): ',
    );
    const noCompany =
      noCompanyAnswer.toLowerCase() === 'n' ||
      noCompanyAnswer.toLowerCase() === 'não' ||
      noCompanyAnswer.toLowerCase() === 'nao';

    // 7. Mostrar campos que serão incluídos nos DTOs
    const createFields = schemaModel.fields.filter((field) =>
      shouldIncludeFieldInDTO(field, true),
    );
    const updateFields = schemaModel.fields.filter((field) =>
      shouldIncludeFieldInDTO(field, false),
    );

    console.log('\nCampos do Create DTO:');
    createFields.forEach((field) => {
      console.log(
        `  - ${field.name}: ${field.type}${field.isOptional ? '?' : ''}`,
      );
    });
    if (hasImage) {
      console.log('  - image: any (opcional)');
    }

    console.log('\nCampos do Update DTO:');
    updateFields.forEach((field) => {
      console.log(
        `  - ${field.name}?: ${mapPrismaTypeToTypeScript(field.type)}`,
      );
    });
    if (hasImage) {
      console.log('  - image?: any');
    }

    // 8. Confirmar geração
    const confirm = await askQuestion(rl, '\nDeseja gerar a entidade com esses campos? (s/n): ');
    if (confirm.toLowerCase() !== 's' && confirm.toLowerCase() !== 'sim') {
      process.exit(0);
    }

    // 9. Gerar a entidade
    await generateEntity(
      featureName,
      selectedModel,
      schemaModel,
      hasImage,
      noCompany,
      isGroup,
      groupName,
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
  noCompany: boolean,
  isGroup: boolean,
  groupName: string,
) {
  // Format entity name
  const entityName = featureName.toLowerCase();
  const entityNamePascal = toPascalCase(entityName);
  const entityNamePlural = entityName + 's';

  // Definir diretório base
  let entityDir = '';
  let uploadImportPath = '';
  if (isGroup) {
    entityDir = path.join(
      process.cwd(),
      'src',
      'features',
      groupName,
      entityName,
    );
    uploadImportPath = '../../upload/upload.middleware';
    // Se o grupo não existir, criar pasta
    const groupDir = path.join(process.cwd(), 'src', 'features', groupName);
    if (!fs.existsSync(groupDir)) {
      fs.mkdirSync(groupDir, { recursive: true });
    }
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
  const associationsContent = `export const paramsIncludes = {\n  // Exemplo: relationName: true,\n};\n`;
  fs.writeFileSync(path.join(entityDir, 'associations.ts'), associationsContent);

  // Gerar rules.ts
  const rulesContent = `export const noCompany = ${noCompany};\n`;
  fs.writeFileSync(path.join(entityDir, 'rules.ts'), rulesContent);

  // Generate service.ts
  const serviceContent = `import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class ${entityNamePascal}Service extends GenericService<
  CreateDto,
  UpdateDto,
  IEntity
> {
  constructor(protected prisma: PrismaService) {
    super(prisma, null);
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
import { getMulterOptions } from '${uploadImportPath}';
// Import generic controller
import { GenericController } from 'src/features/generic/generic.controller';
import { Public } from 'src/auth/decorators/public.decorator';
// Import de configuraões
import { paramsIncludes } from './associations';
import { noCompany } from './rules';

function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: '${schemaModel.name}' as keyof PrismaClient,
  name: '${entityNamePascal}',
  route: '${entityNamePlural}',
  permission: '${entityNamePlural}',
};

@Controller(entity.route)
export class ${entityNamePascal}Controller extends GenericController<
  CreateDto,
  UpdateDto,
  IEntity,
  Service
> {
  constructor(private readonly Service: Service) {
    super(Service, entity);
  }

  @UserPermission(\`list_\${entity.permission}\`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Get()
  async get(@Req() request: Request, @Query() query: any) {
    return super.get(request, query, paramsIncludes, noCompany);
  }

  @UserPermission(\`create_\${entity.permission}\`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Post()
  @UseInterceptors(FileInterceptor('image', getMulterOptions('${entityName}-image')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async create(
    @Req() request: Request,
    @Body() CreateDto: CreateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    const search = {};
    return super.create(request, CreateDto, file, search);
  }

  @UserPermission(\`update_\${entity.permission}\`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Put(':id')
  @UseInterceptors(FileInterceptor('image', getMulterOptions('${entityName}-image')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async update(
    @Param('id') id: number,
    @Req() request: Request,
    @Body() UpdateDto: UpdateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    return super.update(id, request, UpdateDto, file);
  }

  @UserPermission(\`activate_\${entity.permission}\`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Patch('active/:id')
  async activate(@Param('id') id: number, @Req() request: Request) {
    return super.activate(id, request);
  }

  @UserPermission(\`inactive_\${entity.permission}\`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Patch('inactive/:id')
  async inactivate(@Param('id') id: number, @Req() request: Request) {
    return super.inactivate(id, request);
  }
}
`;

  // Generate module.ts
  const moduleContent = `import { Module } from '@nestjs/common';
import { ${entityNamePascal}Controller as Controller } from './controller';
import { ${entityNamePascal}Service as Service } from './service';
import { UploadModule } from '../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class ${entityNamePascal}Module {}
`;

  // Generate create.dto.ts
  let createDtoContent = `import { Type } from 'class-transformer';
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
    const validators = getValidatorsForType(field.type, field);
    const tsType = mapPrismaTypeToTypeScript(field.type);

    createDtoContent += `
  ${validators.join('\n  ')}
  ${field.name}${field.isOptional ? '?' : ''}: ${tsType};
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
  let updateDtoContent = `import { Type } from 'class-transformer';
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
  fs.writeFileSync(path.join(entityDir, 'service.ts'), serviceContent);
  fs.writeFileSync(path.join(entityDir, 'controller.ts'), controllerContent);
  fs.writeFileSync(path.join(entityDir, 'module.ts'), moduleContent);
  fs.writeFileSync(path.join(dtoDir, 'create.dto.ts'), createDtoContent);
  fs.writeFileSync(path.join(dtoDir, 'update.dto.ts'), updateDtoContent);
  fs.writeFileSync(path.join(interfacesDir, 'interface.ts'), interfaceContent);

  // Mensagem de sucesso e próximos passos
  console.log('\n✅ Entidade gerada com sucesso!');
  console.log('\n📋 Próximos passos:');
  console.log(`1. Revise e ajuste os arquivos gerados: rules.ts (noCompany) e associations.ts (paramsIncludes)`);
  console.log(`2. Importe o módulo gerado no app.module.ts para ativar a rota:`);
  if (isGroup) {
    console.log(`   import { ${toPascalCase(featureName)}Module } from './features/${groupName}/${entityName}/${entityName}.module';`);
    console.log(`   imports: [ ..., ${toPascalCase(featureName)}Module ]`);
  } else {
    console.log(`   import { ${toPascalCase(featureName)}Module } from './features/${entityName}/${entityName}.module';`);
    console.log(`   imports: [ ..., ${toPascalCase(featureName)}Module ]`);
  }
  console.log('3. Execute "prisma generate" se necessário');
  console.log('4. Teste as rotas geradas');
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
