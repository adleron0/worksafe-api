# vendor/

`adleron-crud-core-<versão>.tgz` é o pacote `@adleron/crud-core` empacotado.
Fica no repositório para o build do Railway não depender de registry privado
nem de token.

Atualizar após mudar a lib:

    cd ../crud-core && pnpm verify && pnpm build && npm pack --pack-destination ../worksafe/worksafe-api/vendor
    cd ../worksafe/worksafe-api && npm pkg set "dependencies.@adleron/crud-core=file:vendor/adleron-crud-core-<versão>.tgz" && npm install

Suba a versão em `crud-core/package.json` a cada mudança, senão o npm reaproveita o cache.
