# Entity Generator CLI

This CLI tool generates entity files following the generic pattern used in the project. It creates all the necessary files for a new entity, including controller, service, module, DTOs, and interfaces.

## Usage

```bash
npm run generate:entity <entityName> [options]
```

### Options

- `--has-image`: Add this flag if the entity should support image uploads
- `--field=name:type:required`: Add fields to the entity DTOs
  - `name`: The name of the field
  - `type`: The type of the field (string, number, int, float, boolean, date, email, url)
  - `required`: Add 'required' if the field is required in the create DTO

### Examples

Generate a basic product entity:
```bash
npm run generate:entity product
```

Generate a product entity with image support:
```bash
npm run generate:entity product --has-image
```

Generate a product entity with custom fields:
```bash
npm run generate:entity product --field=name:string:required --field=price:number:required --field=description:string
```

Generate a product entity with image support and custom fields:
```bash
npm run generate:entity product --has-image --field=name:string:required --field=price:number:required --field=description:string
```

## Generated Files

The CLI will generate the following files:

- `src/<entityName>/service.ts`: Service class that extends GenericService
- `src/<entityName>/controller.ts`: Controller class that extends GenericController
- `src/<entityName>/module.ts`: Module class that imports the controller and service
- `src/<entityName>/dto/create.dto.ts`: DTO for create operations
- `src/<entityName>/dto/update.dto.ts`: DTO for update operations
- `src/<entityName>/interfaces/interface.ts`: Interface that extends the Prisma model

## After Generation

After generating the entity files, you need to:

1. Add the entity module to `app.module.ts` imports
2. Update the Prisma schema if needed
3. Run `npx prisma generate` to update the Prisma client
4. Customize the interface.ts file to add relations
5. Customize the search parameters in controller.ts if needed

## Entity Structure

The generated entity follows the generic pattern used in the project:

- The service extends GenericService
- The controller extends GenericController
- The DTOs include validation decorators
- The interface extends the Prisma model

## Customization

You may need to customize the generated files to fit your specific requirements:

- Add specific search parameters in the controller's create method
- Add relations in the interface
- Add specific validation rules in the DTOs
- Add specific business logic in the service
