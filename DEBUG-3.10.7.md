# Debug final — LordMarketplacesAnalytics 3.10.7

**Data:** 27/11/2026  
**Runtime disponível:** Node.js v22.16.0.  
**Resultado:** verificações estáticas, smoke SQLite e build da extensão aprovados; testes dependentes de dependências ausentes e homologação real permanecem bloqueados/não executados.

## Verificações aprovadas

| Verificação | Resultado |
|---|---:|
| `npm run ext:build` | **Aprovado; 8 arquivos referenciados; manifest 3.10.7** |
| `node scripts/audit-project.mjs` | **500/500** |
| `node --experimental-strip-types scripts/smoke-local-features.mjs` | **7/7 grupos** |
| `node scripts/audit-publish-flow.mjs` | **10 checks** |
| `node scripts/db-generate.mjs --check` | **17 migrations; 163 objetos; `integrity_check=ok`; 0 violações FK** |
| `node --check` em JS/MJS/CJS | **20 arquivos; 0 erros** |
| Parser TypeScript global | **54 arquivos TS/TSX; 0 diagnósticos de sintaxe** |
| Parse dos JSONs do projeto | **11 arquivos; 0 erros** |

### O que foi validado na nova migration 017

- As colunas de progresso e a tabela `sync_batch_page_runs` são aplicadas no SQLite.
- O estado salvo contém páginas concluídas, cursor atual e links pendentes; é possível ler e reconstruir o estado após reabertura do banco.
- A chave `(batch, conta, página)` mantém o registro idempotente via `ON CONFLICT`.
- O banco aceita os estados de página `COMPLETED`, `FAILED` e `QUEUED`.
- As migrations completas deixam `integrity_check=ok` e `foreign_key_check=0`.

### Auditoria estática 500/500

Inclui verificação de método IPC e permissão para `sync.accountProgress`, migration 017, validação de host HTTPS, sanitização de URLs, persistência de `seenUrls`/`pendingLinks`, retomada após lease expirado, notificação de progresso por página e regra que impede lote `COMPLETED` quando há páginas pendentes.

### Smoke local 7/7

O grupo SQLite agora inclui progresso por página, restauração de estado após interrupção, links pendentes, histórico de páginas, atualização idempotente e estado `QUEUED`, além dos testes anteriores de agenda, retry, usuários e importação.

## Bloqueios reproduzidos

| Comando/ambiente | Resultado | Motivo |
|---|---|---|
| `npm test` | **Bloqueado** | `vitest: not found` |
| `npm run typecheck` | **Bloqueado** | TS2688: faltam `@types/node` e `vitest/globals`; typecheck semântico não executado |
| `npm run agent:build` | **Bloqueado** | `esbuild` não instalado |
| `npm run host:build` | **Bloqueado** | `esbuild` não instalado |
| Instalador Windows | **Não gerado** | `ISCC.exe`/Inno Setup ausente |
| Chrome/Edge com vendedor autenticado | **Não executado** | não havia navegador/sessão real de vendedor para homologação |
| OAuth e APIs externas | **Não executados** | credenciais e configuração de provedores ausentes |

A tentativa anterior de `npm ci` ultrapassou o limite de execução do ambiente; o `node_modules` parcial foi removido. Nenhum dos testes bloqueados foi apresentado como aprovado.

## Classificação dos requisitos

- **187/365 implementados no código**.
- **178 parciais ou não comprovados** (173 parciais, 2 homologações Chrome/Edge não comprovadas e 3 validações não comprovadas nesta execução).
- **0 completamente ausentes** na matriz atual.

As promoções desta rodada foram os requisitos 21, 22 e 24. A retomada automática está implementada para lotes de coleta agendados recuperados após lease obsoleto; não significa que toda operação da aplicação retome automaticamente nem substitui a homologação de navegador real.

## Segurança observada no código

- Sem leitura de cookies, headers ou tokens do marketplace.
- Sem chamada a endpoints privados.
- URLs de progresso limitadas a HTTPS e hosts do marketplace correspondentes; usuário/senha/hash são removidos e só parâmetros reconhecidos de paginação são persistidos.
- Sem alternância de contas ou sessão; correspondência exata com identidade visível da conta.
- Falha de captura permanece pendente; captura na fila local é marcada `QUEUED`; lote com links restantes termina `PARTIAL`.
