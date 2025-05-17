# CLI Gerador de Entidade

Esta ferramenta CLI gera arquivos de entidade seguindo o padrão genérico usado no projeto. Ela cria todos os arquivos necessários para uma nova entidade, incluindo controller, service, module, DTOs e interfaces.

## Uso

```bash
npm run gen:entity <nomeDaEntidade> [opcoes]
```

### Opções

- `--`: Se houver campos, é necessário `--` antes do nome
- `--has-image`: Adicione esta flag se a entidade deve suportar uploads de imagem
- `--field=nome:tipo:obrigatorio`: Adiciona campos aos DTOs da entidade
  - `nome`: O nome do campo
  - `tipo`: O tipo do campo (string, number, int, float, boolean, date, email, url)
  - `obrigatorio`: Adicione 'required' se o campo for obrigatório no DTO de criação

### Exemplos

Gerar uma entidade básica de produto:
```bash
npm run gen:entity product
```

Gerar uma entidade de produto com suporte a imagem:
```bash
npm run gen:entity -- product --has-image
```

Gerar uma entidade de produto com campos personalizados:
```bash
npm run gen:entity -- product --field=name:string:required --field=price:number:required --field=description:string
```

Gerar uma entidade de produto com suporte a imagem e campos personalizados:
```bash
npm run gen:entity -- product --has-image --field=name:string:required --field=price:number:required --field=description:string
```

## Arquivos Gerados

A CLI gerará os seguintes arquivos:

- `src/<nomeDaEntidade>/service.ts`: Classe de serviço que estende GenericService
- `src/<nomeDaEntidade>/controller.ts`: Classe de controller que estende GenericController
- `src/<nomeDaEntidade>/module.ts`: Classe de módulo que importa o controller e o serviço
- `src/<nomeDaEntidade>/dto/create.dto.ts`: DTO para operações de criação
- `src/<nomeDaEntidade>/dto/update.dto.ts`: DTO para operações de atualização
- `src/<nomeDaEntidade>/interfaces/interface.ts`: Interface que estende o modelo Prisma

## Após a Geração

Após gerar os arquivos da entidade, você precisa:

1. Adicionar o módulo da entidade aos imports do `app.module.ts`
2. Revisar os DTOs para garantir que eles estejam funcionando conforme o esperado
3. Personalizar o arquivo interface.ts para adicionar relações
4. Personalizar os parâmetros de busca no controller.ts, se necessário ([veja o campo personalização]#personalizacao)

## Estrutura da Entidade

A entidade gerada segue o padrão genérico usado no projeto:

- O serviço estende GenericService
- O controller estende GenericController
- Os DTOs incluem decoradores de validação
- A interface estende o modelo Prisma

## Personalização

Você pode precisar personalizar os arquivos gerados para atender aos seus requisitos específicos:

- Verifique se os campos da entidade estão nomeados corretamente
- Verifique se no GET será necessário o noCompany
- Adicionar parâmetros de busca específicos no método CREATE do controller
- Adicionar relações na interface
- Adicionar regras de validação específicas nos DTOs
- Se necessário funções personalizadas fora do Generic, basta criar uma nova rota no controller e nova função no service da entidade
