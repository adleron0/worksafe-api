# Fontes de certificado

Usadas pelo render de certificados na API
(`src/features/training/trainee_certificate/render/`) e pelo cartão de
compartilhamento (`share-card.service.ts`, satori).

Espelham `GOOGLE_FONTS` de `worksafe-front/.../geradorCertificados/utils/fontConfig.ts`
(pesos 400 e 700; Bebas Neue só 400). **Fonte nova no editor = arquivo novo aqui
e entrada em `CERTIFICATE_FONTS` (`render/fabric-setup.ts`)**, senão o texto sai
com a fonte padrão do servidor.

| Família no JSON | Arquivos | Origem | Licença |
|---|---|---|---|
| Bebas Neue | `bebas-neue-400.ttf` | fontsource `bebas-neue` | SIL OFL 1.1 |
| Roboto | `roboto-{400,700}.ttf` | fontsource `roboto` | SIL OFL 1.1 |
| Open Sans | `open-sans-{400,700}.ttf` | fontsource `open-sans` | SIL OFL 1.1 |
| Lato | `lato-{400,700}.ttf` | fontsource `lato` | SIL OFL 1.1 |
| Montserrat | `montserrat-{400,700}.ttf` | fontsource `montserrat` | SIL OFL 1.1 |
| Poppins | `poppins-{400,700}.ttf` | fontsource `poppins` | SIL OFL 1.1 |
| Raleway | `raleway-{400,700}.ttf` | fontsource `raleway` | SIL OFL 1.1 |
| Inter | `inter-{400,700}.ttf` | fontsource `inter` | SIL OFL 1.1 |
| Playfair Display | `playfair-display-{400,700}.ttf` | fontsource `playfair-display` | SIL OFL 1.1 |
| Oswald | `oswald-{400,700}.ttf` | fontsource `oswald` | SIL OFL 1.1 |
| Merriweather | `merriweather-{400,700}.ttf` | fontsource `merriweather` | SIL OFL 1.1 |
| Arial | `arimo-{400,700}.ttf` | fontsource `arimo` (métricas iguais às da Arial) | Apache 2.0 |

Subconjunto *latin* (cobre os acentos do português). Baixadas de
`https://cdn.jsdelivr.net/fontsource/fonts/<familia>@latest/latin-<peso>-normal.ttf`.
