# Debug final — LordMarketplacesAnalytics 3.10.5

**Data:** 27/11/2026  
**Ambiente:** Node.js 22.16.0; dependências npm do workspace não instaladas.  
**Resultado:** testes offline e build da extensão aprovados; validação Vitest, typecheck semântico, builds do agente/Native Host e navegador real não executados por bloqueios descritos abaixo.

## 1. Verificações aprovadas

| Verificação | Resultado |
|---|---:|
| Auditoria estática `node scripts/audit-project.mjs` | **481/481** |
| Smoke local `node --experimental-strip-types scripts/smoke-local-features.mjs` | **7/7 grupos** |
| Smoke de publicação `node scripts/audit-publish-flow.mjs` | **10 checks** |
| `node scripts/db-generate.mjs --check` | **16 migrations, 161 objetos, integrity=ok, foreign_keys=0** |
| Build MV3 `npm run ext:build` | **8 arquivos referenciados, manifest 3.10.5** |
| `node --check` JS/MJS/CJS | **20 arquivos, 0 falhas** |
| Parser TypeScript global | **54 arquivos TS/TSX, 0 erros de parsing** |
| JSON parse | **9 arquivos, 0 erros** |
| ZIP final | testado com `unzip -t` após empacotamento |

### Smoke local 7/7

1. CSV: delimitadores, aspas, BOM/duplicidade e multilinha.
2. XLSX: arquivo OpenXML comprimido e tipos de célula.
3. PDF: PDF digital sintético, extração de texto e rejeição de bytes que não são PDF.
4. Cadência customizada: limites 15–43200 minutos.
5. Próxima ocorrência: âncora temporal e pulo de ciclos perdidos.
6. Retentativas: backoff 5/15/60 minutos e limite de três retentativas após tentativa inicial.
7. SQLite: 16 migrations, histórico de agenda de análise/relatório/sync, retry elegível, exclusão de conta inativa/em lote ativo, conta específica, limites e integridade.

### Fluxo de publicação 10 checks

Isolamento de conta/ID externo, consumo único, rejeição de autorização duplicada, reversão de transação concorrente, evidência do estado anterior/depois e integridade SQLite.

## 2. Verificações bloqueadas

| Comando | Resultado observado | Motivo |
|---|---|---|
| `npm test` | `vitest: not found` | Vitest não instalado |
| `npm run typecheck` | TS2688 para `node` e `vitest/globals` | `@types/node` e tipos Vitest ausentes; typecheck semântico não concluído |
| `npm run agent:build` | `ERR_MODULE_NOT_FOUND: esbuild` | `esbuild` não instalado |
| `npm run host:build` | `ERR_MODULE_NOT_FOUND: esbuild` | `esbuild` não instalado |
| Instalador Windows | `ISCC.exe` não encontrado | Inno Setup ausente no ambiente |
| Chrome/Edge com vendedor autenticado | não executado | nenhuma sessão real/ambiente de homologação disponível |

Uma tentativa anterior de `npm ci` ultrapassou o limite de execução e o `node_modules` parcial foi removido antes de empacotar. Não foi apresentada como instalação bem-sucedida.

## 3. Observações de segurança/execução

- Alarmes MV3 disparam a cada minuto; a extensão reivindica lotes agendados no serviço local.
- A captura só usa aba já aberta cuja identidade visível corresponde ao `accountId` previsto.
- Nenhuma sessão é alternada automaticamente.
- Sem aba correspondente, a conta é registrada como `SKIPPED`.
- A recuperação de lease ocorre após 30 minutos; contas já terminais não são repetidas no mesmo lote.
- Retry manual cria um novo lote e exclui contas inativas ou já presentes em outro lote `QUEUED`/`RUNNING`.
- Com navegador/extension fechados, a agenda não executa captura; não é uma integração API em background.

## 4. Classificação da matriz

**183 implementados no código, 182 parciais/não comprovados, 0 completamente ausentes; 365 IDs únicos.** Foram promovidos nesta rodada os requisitos 54–59 e 62. Os itens que dependem de integração OAuth/API, sessões reais e homologação externa permanecem parciais/não comprovados.
