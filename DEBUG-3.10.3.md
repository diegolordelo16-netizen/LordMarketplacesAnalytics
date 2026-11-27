# Debug final — LordMarketplacesAnalytics 3.10.3

**Data:** 27/11/2026  
**Base:** pacote 3.10.2 + fluxo de publicação assistida e snapshot anterior.

## Resultado

| Verificação | Resultado | Observação |
|---|---|---|
| Auditoria estática | **417/417 aprovada** | `node scripts/audit-project.mjs` |
| Smoke test de publicação | **Aprovado** | `node scripts/audit-publish-flow.mjs`; 10 verificações de isolamento, replay, duplicidade, change set e integridade |
| Migrations SQLite | **14 aprovadas** | `node scripts/db-generate.mjs --check` |
| Objetos SQLite | **154** | `integrity_check=ok`, `foreign_key_check=0` |
| Extensão MV3 | **Build aprovado** | `npm run ext:build`; 8 arquivos referenciados; manifest 3.10.3 |
| JavaScript/MJS/CJS | **19 arquivos aprovados** | `node --check`, sem erros de sintaxe |
| TypeScript/TSX | **52 arquivos aprovados no parser** | zero erros de parsing; não substitui `tsc` semântico |

## Bloqueios reproduzidos

| Comando | Resultado observado |
|---|---|
| `npm ci --prefer-offline` | Não concluiu: excedeu 120 segundos; instalação parcial removida |
| `npm test -- --run` | Bloqueado: `vitest: not found` |
| `npm run typecheck` | Bloqueado: tipos `node` e `vitest/globals` ausentes |
| `npm run agent:build` | Bloqueado: pacote `esbuild` ausente/incompleto |
| `npm run host:build` | Bloqueado: pacote `esbuild` ausente/incompleto |
| Homologação Chrome/Edge | Não executada: não havia sessão real de vendedor disponível |
| Publicação real | Não executada: nenhuma conta externa foi alterada nesta validação |

## Testes de segurança do fluxo

- Autorização limitada a `super_admin` e permissão `manage_accounts` para aprovar, reivindicar e registrar resultado.
- Lote máximo 10 itens, uma conta e marketplace, anúncios sem duplicação.
- Confirmação exata `PUBLICAR N`, justificativa obrigatória e expiração de 15 minutos.
- Conta, externalListingId, host de origem e snapshot anterior vinculados ao item.
- A extensão só tenta executar na aba ativa, autenticada e da conta correspondente.
- Confirmação nativa por anúncio; botão de salvar precisa ser único e inequívoco.
- Resultado `PUBLISHED` exige mensagem positiva nova e campo observado após salvar.
- Sem prova, status incerto e nenhuma retentativa automática.
- Aprovação é consumida uma única vez; retorno não pode ser enviado por operador.
- Toda transição de status confere a quantidade de linhas alteradas; conflito reverte a transação, impedindo aprovação órfã ou conclusão de item fora de `PUBLISHING`.
- Rollback cria um rascunho de título e não executa escrita remota.

## Conclusão

O requisito #284 deixou de ser totalmente ausente e passou a parcialmente implementado no código para Mercado Livre e Shopee. O fluxo está testado no schema SQLite e nas verificações estáticas, mas a interação real do navegador e a confirmação do marketplace não foram homologadas. Portanto, não há afirmação de publicação remota bem-sucedida nesta rodada.
