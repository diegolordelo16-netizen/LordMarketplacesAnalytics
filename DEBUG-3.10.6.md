# Debug final — LordMarketplacesAnalytics 3.10.6

**Data:** 27/11/2026  
**Node:** v22.16.0.  
**Resultado:** verificações offline e extensão aprovadas; dependências ausentes impedem alguns testes e builds.

## Aprovado

| Verificação | Resultado |
|---|---:|
| `node scripts/audit-project.mjs` | **487/487** |
| `node --experimental-strip-types scripts/smoke-local-features.mjs` | **7/7 grupos** |
| `node scripts/audit-publish-flow.mjs` | **10 checks** |
| `node scripts/db-generate.mjs --check` | **16 migrations; 161 objetos; integrity=ok; foreign_keys=0** |
| `npm run ext:build` | **8 arquivos referenciados; manifest 3.10.6** |
| `node --check` JS/MJS/CJS | **20 arquivos; 0 erros** |
| Parser TypeScript global | **54 arquivos TS/TSX; 0 erros de parsing** |
| Parse de JSON do projeto | **9 arquivos; 0 erros** |
| ZIP final | validado com `unzip -t` |

### Conteúdo do smoke local 7/7

1. CSV: separador, aspas, cabeçalhos duplicados e campos multilinha.
2. XLSX: ZIP OpenXML comprimido e tipos de células.
3. PDF digital: extração do texto e rejeição de conteúdo que não é PDF.
4. Cadência customizada de 15 a 43200 minutos.
5. Recorrência com âncora e pulo de ciclos perdidos.
6. Backoff de 5/15/60 minutos e limite de três retentativas após tentativa inicial.
7. SQLite: migrations/históricos, retry somente para contas elegíveis, exclusão de conta inativa e de conta já em lote pendente, papéis de usuário, e-mail único e limites de cadência.

### Fluxo de publicação 10 checks

Isolamento por conta/ID externo, consumo único, rejeição de autorização duplicada, rollback de transação concorrente, evidência de before/after e integridade SQLite.

## Bloqueios reproduzidos

| Comando | Resultado | Motivo |
|---|---|---|
| `npm test` | `vitest: not found` | Vitest não instalado |
| `npm run typecheck` | TS2688 para `node` e `vitest/globals` | `@types/node` e tipos Vitest ausentes; não é typecheck semântico aprovado |
| `npm run agent:build` | `ERR_MODULE_NOT_FOUND: esbuild` | `esbuild` não instalado |
| `npm run host:build` | `ERR_MODULE_NOT_FOUND: esbuild` | `esbuild` não instalado |
| Instalador Windows | `ISCC.exe` não encontrado | Inno Setup ausente |
| Chrome/Edge real | não executado | não havia ambiente/sessão autenticada de vendedor |

Uma tentativa anterior de `npm ci` excedeu o limite de execução; o `node_modules` parcial foi removido antes do empacotamento. Não foi apresentado como instalação concluída.

## Segurança e limitações

- A área de usuários só é mostrada quando `auth.session` retorna papel `super_admin`; o serviço ainda exige `manage_users` para cada chamada.
- O serviço bloqueia auto-desativação e desativação/rebaixamento do último `super_admin`; desativar revoga sessões do usuário.
- A coleta agendada exige navegador/extension ativos e aba já autenticada com identidade coincidente. Não alterna sessões; sem aba correspondente, marca `SKIPPED`.
- Retry da coleta cria lote novo auditável, exclui contas inativas ou em outro lote pendente e exige execução no navegador.
- Não houve OAuth/API, coleta ao vivo, publicação real nem homologação de sessão.

## Matriz

**184 implementados no código, 181 parciais/não comprovados, 0 completamente ausentes; 365 IDs únicos.** Nesta sequência foram promovidos os requisitos 2, 54–59, 62, 256 e 258. Isso não significa que 181 requisitos estejam concluídos: permanecem limitações de cobertura, integrações externas, tipos de coleta e homologação real.
