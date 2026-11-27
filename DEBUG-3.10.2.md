# Debug final — LordMarketplacesAnalytics 3.10.2

**Data:** 27/11/2026

| Verificação | Resultado |
|---|---|
| Auditoria estática | **391/391 aprovadas** |
| Build da extensão | Aprovado: `dist/extension`, 8 arquivos referenciados |
| JavaScript/MJS/CJS do projeto | `node --check` aprovado em 18 arquivos fonte |
| TypeScript/TSX | 52 arquivos parseados; 0 erros sintáticos |
| Migrations SQLite | 001–012 aplicadas em memória |
| Objetos SQLite | 150 |
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | 0 registros |
| `db-generate --check` | aprovado |
| Vitest | **Bloqueado**: pacote não instalado; `npm ci` online excedeu o tempo e modo offline não encontrou pacote `zod` no cache |
| Typecheck semântico | **Bloqueado**: não há `@types/node` nem `vitest/globals` |
| Build do agente/host | **Bloqueado**: pacote `esbuild` ausente |
| Chrome/Edge com contas reais | Não executado nesta sessão |
| APIs/OAuth/publicação | Não homologadas; nenhuma escrita remota feita |

## Erros encontrados e corrigidos durante a rodada

1. Duas chamadas do coletor de oferta foram inseridas acidentalmente no handler de `MI_CAPTURE_PAGE_INFO`, com variáveis inexistentes. A auditoria estática acusou duas regressões; as chamadas foram removidas e a auditoria voltou a 391/391.
2. O ciclo de agendamentos recebeu guarda contra execução concorrente para evitar processamento duplicado quando uma análise ultrapassar o intervalo do timer.
3. Formato de relatórios agendados foi restringido a JSON nesta versão; CSV/XLSX agendado não é declarado como suporte enquanto não houver serializador/binário para os jobs.
4. Seed idempotente foi incluído para evitar que a opção “todos os marketplaces habilitados” não encontre marketplaces por falta de registro inicial.

## Conclusão

O build da extensão, auditoria estática, sintaxe dos scripts e integridade do banco passaram. Não foi possível declarar aprovação geral da suíte: Vitest, typecheck semântico e builds do agente/Native Host não rodaram por dependências ausentes. Homologação em contas reais, OAuth e publicação também não foram realizadas.
