#!/usr/bin/env ts-node

import * as fs from 'fs';
import * as path from 'path';

// Parse command line arguments
const args = process.argv.slice(2);
const entityNameArg = args.find((arg) => !arg.startsWith('--'));
const hasImage = args.includes('--has-image');
const fields = args
  .filter((arg) => arg.startsWith('--field='))
  .map((arg) => {
    const [name, type, required] = arg.replace('--field=', '').split(':');
    return { name, type, required: required === 'required' };
  });
console.log('Parsed fields:', args);

if (!entityNameArg) {
  console.error('Please provide an entity name');
  console.log(
    'Usage: npm run gen:entity -- <entityName> [--has-image] [--field=name:type:required]',
  );
  console.log(
    'Example: npm run gen:entity -- product --has-image --field=name:string:required --field=price:number:required',
  );
  process.exit(1);
}

function toPascalCase(entityName) {
  if (entityName.includes('_')) {
    // Se houver underscore, divide a string em partes, capitaliza cada uma e junta sem separadores
    return entityName
      .split('_')
      .map(
        (word: string) =>
          word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
      )
      .join('');
  } else {
    // Se não houver underscore, apenas transforma a primeira letra em maiúscula
    return entityName.charAt(0).toUpperCase() + entityName.slice(1);
  }
}

function capitalizeFirstLetterEachWork(entityName) {
  if (entityName.includes('_')) {
    // Se houver underscore, divide a string em partes, capitaliza cada uma e junta sem separadores
    return entityName
      .split('_')
      .map(
        (word: string) =>
          word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
      )
      .join('_');
  } else {
    // Se não houver underscore, apenas transforma a primeira letra em maiúscula
    return entityName.charAt(0).toUpperCase() + entityName.slice(1);
  }
}

// Format entity name
const entityName = entityNameArg.toLowerCase();
const entityNamePascal = toPascalCase(entityName);
const entityNameCapitalized = capitalizeFirstLetterEachWork(entityName);
const entityNamePlural = entityName + 's'; // Simple pluralization, might need to be more sophisticated

// Create directory structure
const entityDir = path.join(process.cwd(), 'src', entityName);
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

// Generate service.ts
const serviceContent = `import { Injectable } from '@nestjs/common';
import { GenericService } from 'src/generic/generic.service';
// entity template imports
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';

@Injectable()
export class ${entityNamePascal}Service extends GenericService<
  CreateDto,
  UpdateDto,
  IEntity
> {}
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
import { getMulterOptions } from '../upload/upload.middleware';
// Import generic controller
import { GenericController } from 'src/generic/generic.controller';

// Create a decorator factory for User controller permissions
function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: '${entityName}' as keyof PrismaClient,
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

  // Rota intermediária para validação de permissão
  @UserPermission(\`list_\${entity.permission}\`) // Permissão para rota genérica
  @Get()
  async get(@Req() request: Request, @Query() query: any) {
    const noCompany = false; // quando a rota não exige buscar companyId pelo token
    // filtros e atributos de associações
    const paramsIncludes = {};
    return super.get(request, query, paramsIncludes, noCompany);
  }

  // Rota intermediária para validação de permissão
  @UserPermission(\`create_\${entity.permission}\`) // Permissão para rota genérica
  @Post()
  @UseInterceptors(FileInterceptor('image', getMulterOptions('${entityName}-image')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async create(
    @Req() request: Request,
    @Body() CreateDto: CreateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    const search = {}; // Customize search parameters if needed
    return super.create(request, CreateDto, file, search);
  }

  // Rota intermediária para validação de permissão
  @UserPermission(\`update_\${entity.permission}\`) // Permissão para rota genérica
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

  // Rota intermediária para validação de permissão
  @UserPermission(\`activate_\${entity.permission}\`) // Permissão para rota genérica
  @Patch('active/:id')
  async activate(@Param('id') id: number, @Req() request: Request) {
    return super.activate(id, request);
  }

  // Rota intermediária para validação de permissão
  @UserPermission(\`inactive_\${entity.permission}\`) // Permissão para rota genérica
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

// Add fields from command line arguments
fields.forEach((field) => {
  const decorators = [];

  // Type decorator
  switch (field.type) {
    case 'string':
      decorators.push('@IsString()');
      break;
    case 'number':
    case 'int':
      decorators.push('@IsInt()');
      decorators.push('@Type(() => Number)');
      break;
    case 'float':
      decorators.push('@IsNumber()');
      decorators.push('@Type(() => Number)');
      break;
    case 'boolean':
      decorators.push('@IsBoolean()');
      decorators.push('@Type(() => Boolean)');
      break;
    case 'date':
      decorators.push('@IsDate()');
      decorators.push('@Type(() => Date)');
      break;
    case 'email':
      decorators.push("@IsEmail({}, { message: 'Invalid email format' })");
      break;
    case 'url':
      decorators.push("@IsUrl({}, { message: 'Invalid URL format' })");
      break;
    case 'json':
      decorators.push('@IsJSON()');
      break;
    default:
      decorators.push('@IsString()');
  }

  // Required/Optional decorator
  if (field.required === true) {
    decorators.push(`@IsNotEmpty({ message: '${field.name} is required' })`);
  } else {
    decorators.push('@IsOptional()');
  }

  // Add field to DTO
  createDtoContent += `
  ${decorators.join('\n  ')}
  ${field.name}: ${
    field.type === 'string' || field.type === 'email' || field.type === 'url'
      ? 'string'
      : field.type === 'number' ||
          field.type === 'int' ||
          field.type === 'float'
        ? 'number'
        : field.type === 'boolean'
          ? 'boolean'
          : field.type === 'date'
            ? 'Date'
            : field.type === 'json'
              ? 'JSON'
              : 'string'
  };
`;
});

// Add image field if needed
if (hasImage) {
  createDtoContent += `
  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional()
  imageUrl?: string | null;

  @IsOptional()
  image?: any; // Permitir que seja tratado como arquivo no Controller
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

// Add fields from command line arguments
fields.forEach((field) => {
  const decorators = [];

  // Type decorator
  switch (field.type) {
    case 'string':
      decorators.push('@IsString()');
      break;
    case 'number':
    case 'int':
      decorators.push('@IsInt()');
      decorators.push('@Type(() => Number)');
      break;
    case 'float':
      decorators.push('@IsNumber()');
      decorators.push('@Type(() => Number)');
      break;
    case 'boolean':
      decorators.push('@IsBoolean()');
      decorators.push('@Type(() => Boolean)');
      break;
    case 'date':
      decorators.push('@IsDate()');
      decorators.push('@Type(() => Date)');
      break;
    case 'email':
      decorators.push("@IsEmail({}, { message: 'Invalid email format' })");
      break;
    case 'url':
      decorators.push("@IsUrl({}, { message: 'Invalid URL format' })");
      break;
    case 'json':
      decorators.push('@IsJSON()');
      break;
    default:
      decorators.push('@IsString()');
  }

  decorators.push('@IsOptional()');

  // Add field to DTO
  updateDtoContent += `
  ${decorators.join('\n  ')}
  ${field.name}: ${
    field.type === 'string' || field.type === 'email' || field.type === 'url'
      ? 'string'
      : field.type === 'number' ||
          field.type === 'int' ||
          field.type === 'float'
        ? 'number'
        : field.type === 'boolean'
          ? 'boolean'
          : field.type === 'date'
            ? 'Date'
            : field.type === 'json'
              ? 'JSON'
              : 'string'
  };
`;
});

// Add image field if needed
if (hasImage) {
  updateDtoContent += `
  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional()
  imageUrl?: string | null;

  @IsOptional()
  image?: any; // Permitir que seja tratado como arquivo no Controller
`;
}

updateDtoContent += `}
`;

// Generate interface.ts
const interfaceContent = `/* eslint-disable */
import { ${entityNameCapitalized} as Prisma } from '@prisma/client';

// Extender a interface do Prisma
export interface IEntity extends Prisma {
  // Add relations here as needed
  // Example: customers: Customer[];
}

// Tipos auxiliares
// Example: export type Customer = Customers;
`;

// Write files
fs.writeFileSync(path.join(entityDir, 'service.ts'), serviceContent);
fs.writeFileSync(path.join(entityDir, 'controller.ts'), controllerContent);
fs.writeFileSync(path.join(entityDir, 'module.ts'), moduleContent);
fs.writeFileSync(path.join(dtoDir, 'create.dto.ts'), createDtoContent);
fs.writeFileSync(path.join(dtoDir, 'update.dto.ts'), updateDtoContent);
fs.writeFileSync(path.join(interfacesDir, 'interface.ts'), interfaceContent);

console.log(`Entity ${entityNamePascal} generated successfully!`);
console.log(`Files created:`);
console.log(`- src/${entityName}/service.ts`);
console.log(`- src/${entityName}/controller.ts`);
console.log(`- src/${entityName}/module.ts`);
console.log(`- src/${entityName}/dto/create.dto.ts`);
console.log(`- src/${entityName}/dto/update.dto.ts`);
console.log(`- src/${entityName}/interfaces/interface.ts`);

console.log("\nDon't forget to:");
console.log(`1. Add ${entityNamePascal}Module to app.module.ts imports`);
console.log('2. Update the Prisma schema if needed');
console.log('3. Run prisma generate to update the Prisma client');
console.log('4. Customize the interface.ts file to add relations');
console.log('5. Customize the search parameters in controller.ts if needed');
