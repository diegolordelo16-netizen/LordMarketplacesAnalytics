# Lord Marketplaces Analytics

Inteligência operacional de marketplaces, **Local First**: roda no seu computador,
usa a sessão que você já tem aberta no navegador, e guarda tudo em um banco SQLite
local. Sem servidor, sem nuvem obrigatória, sem API oficial de marketplace.

## O que ele faz hoje

- **Reconhece** a página do marketplace aberta (Mercado Livre e Shopee)
- **Captura** a lista de anúncios/produtos do painel do vendedor nos dois — lendo o
  DOM que a página já mostra, nunca endpoint privado
- **Grava com proveniência**: fonte, marketplace, conta, URL, data de referência,
  data de coleta, método e versão do adapter em cada observação
- **Calcula** alertas (estoque zerado, estoque baixo, variação de preço)
- **Planeja**: a IA interna gera recomendações priorizadas, determinísticas e
  auditáveis, e declara o que não consegue concluir
- **Audita** o plano com o Gemini, opcional, com cota diária local
- **Central de Melhorias**: só o proprietário aprova mudanças permanentes

## Regra de integridade

Todo dado carrega um status, e ele nunca é inventado:

| Status | Significado |
|---|---|
| `VERIFIED` | lido da página e legível |
| `ZERO` | zero confirmado na tela — não é ausência |
| `UNKNOWN` | apareceu mas não foi possível interpretar |
| `NOT_COLLECTED` | o campo não estava na página |
| `UNAVAILABLE` | existe mas o marketplace não expõe |
| `ESTIMATED` | derivado de suposição (marcado como tal) |
| `CALCULATED` | resultado de cálculo sobre dados verificados |

**Estoque que não apareceu não é estoque zero.** Confundir os dois faria o sistema
recomendar reposição de um produto cheio. Por isso o banco rejeita observação sem
proveniência completa.

## Estrutura

```
packages/protocol      contrato de mensagens (envelope, namespaces, erros)
apps/local-agent       serviço local: banco, adapters, IA, Gemini, melhorias
apps/extension         extensão MV3: Side Panel + service worker + content script
tests/                 integração extensão ↔ serviço local
scripts/               empacotador Windows
docs/                  arquitetura e guia de uso
```

## Como rodar (desenvolvimento)

Requisitos: Node 22+, pnpm 9+.

```sh
pnpm install
pnpm -r test          # 126 testes
pnpm --filter @lma/local-agent dev    # imprime o token de pareamento
pnpm --filter @lma/extension build    # gera apps/extension/dist
```

Depois carregue `apps/extension/dist` em `chrome://extensions` (modo desenvolvedor),
copie o ID da extensão e reinicie o serviço com:

```sh
LMA_EXTENSION_ORIGIN="chrome-extension://SEU_ID" pnpm --filter @lma/local-agent dev
```

## Como gerar o pacote Windows

```sh
node scripts/package-windows.mjs
```

Produz em `release/`:

- `LordMarketplacesAnalytics/` — pasta portátil com `runtime/node.exe` embutido
- `LordMarketplacesAnalytics-0.1.0.zip` — o mesmo, compactado (~35 MB)

O usuário final **não instala Node, Python, Git nem npm**: abre `start.cmd`.

## Segurança

- O serviço escuta **apenas** em `127.0.0.1`
- Origem validada contra allowlist explícita (`chrome-extension://<id>`), sem curinga
- Token de pareamento de uso único, com expiração e comparação em tempo constante
- Payload limitado por namespace; envelope validado campo a campo
- Trilha de auditoria com encadeamento de hash (adulteração é detectável)
- Nenhuma senha, cookie ou token de marketplace é lido ou transmitido

## Estado

Versão `0.3.0` — prova de conceito completa: captura real, persistência com
proveniência, alertas, plano do cérebro, Gemini opcional, central de melhorias,
pacote Windows portátil e 126 testes verdes.

Ainda não implementado: captura de publicidade,
instalador `Setup.exe` assinado, Native Messaging (depende de extensão publicada).

Detalhes em [`docs/`](docs/).
