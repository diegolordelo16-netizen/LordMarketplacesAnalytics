# LordMarketplacesAnalytics 3.6.0 — implementação, correções e debug

Data: 26/11/2026

## Entregas adicionadas nesta revisão

- Importador CSV com suporte a BOM UTF-8, detecção de delimitador (vírgula, ponto e vírgula ou tab), campos com aspas, aspas escapadas e campos multilinha.
- Leitor XLSX nativo, sem dependência externa: ZIP stored/Deflate, CRC32, shared strings, strings inline, números e booleanos; rejeita arquivos criptografados, Zip64, caminhos inseguros, arquivos truncados e expansão acima dos limites.
- Limites: 2 MB comprimidos, até 20 MB expandidos, 512 entradas ZIP, 10.000 linhas, 100 colunas e 32.000 caracteres por célula.
- Migration 005 adiciona `import_job_rows`, persistindo as linhas normalizadas em staging com referência e unicidade por número de linha.
- Importação em duas fases: primeiro interpreta e guarda; depois exige mapeamento explícito de ID externo, data opcional e ao menos uma métrica.
- Promoção exige conta ativa correspondente, job da mesma conta e anúncio já cadastrado na mesma conta/marketplace. Não cria anúncios automaticamente.
- Valores numéricos são normalizados (por exemplo `1.234,50`); entradas negativas, valores inválidos, avaliação acima de 5, datas inválidas, IDs desconhecidos, duplicatas e snapshots já existentes são rejeitados.
- A gravação de snapshots e proveniência é transacional. Os valores são classificados como `F_USER_INPUT`, com origem `import_job:<id>` e método `CSV_XLSX_USER_IMPORT`.
- Interface apresenta prévia, mapeamento manual dos campos e histórico das importações da conta selecionada. A importação não injeta dados nos KPIs sem confirmação explícita.
- `connector.import.list`, `connector.import.get` e `connector.import.commit` foram adicionados ao contrato IPC e às permissões; histórico e leitura exigem escopo de conta.
- Tabelas da interface recebem pesquisa, ordenação por coluna e paginação client-side (25 linhas).
- Comparação analítica por períodos personalizados não sobrepostos, com agrupamento por conta, produto ou anúncio e métricas ausentes preservadas como nulas.
- Versão do pacote, extensão e painel alinhadas em 3.6.0.

## Verificações executadas nesta revisão

| Verificação | Resultado |
|---|---|
| `node --check` no painel local e todos os scripts JS/MJS/CJS | Passou |
| Parser CSV isolado | Passou para BOM, ponto e vírgula, aspas, campos multilinha e limites |
| Parser XLSX isolado | Passou com fixture OpenXML comprimida, shared strings, número e boolean |
| Proteções de importação | Rejeitou XLSX não ZIP, aspas CSV não fechadas e linhas com colunas extras |
| SQL de snapshot/proveniência | Passou em SQLite real com FK habilitada |
| Comparação de períodos | Teste de regressão adicionado; agregação por snapshot mais recente, sem duplicar capturas |
| Migrations 001–005 | Executaram em SQLite; tabela `import_job_rows` criada |
| Build da extensão | Passou em `node scripts/build-extension.mjs` |
| Suíte Vitest | Não iniciou: executável `vitest` ausente no `node_modules/.bin` |
| Typecheck semântico | Bloqueado: dependências/types de desenvolvimento ausentes ou incompletos |
| Build do serviço local/Native Host | Bloqueado: `esbuild` incompleto/sem executável no ambiente |
| Chrome/Edge e conta real | Não executados |

Os testes de regressão para a suíte Vitest foram adicionados, inclusive staging CSV/XLSX e promoção para snapshots por conta. Eles não podem ser declarados aprovados enquanto `vitest` não puder ser executado.

## Limitações restantes — não foram simuladas como prontas

- O executor do navegador segue em modo DRAFT assistido. Preenche/verifica título ou acréscimo de descrição em Mercado Livre/Shopee; não salva nem publica.
- Amazon não possui adapter/content script operacional.
- A captura depende do DOM visível e não percorre universalmente todas as telas, filtros, períodos, paginações e gráficos.
- CSV/XLSX exigem que o anúncio já exista e mapeamento manual. Não há detecção universal de layouts de todos os relatórios; PDF não é importado.
- Integrações oficiais/OAuth de Mercado Livre, Shopee, Amazon, GA4, Search Console, Trends e provedores externos exigem credenciais, scopes e testes reais não disponíveis neste ambiente.
- Relatórios PDF usam a impressão do navegador; não há renderizador PDF no serviço.
- Automação em AUTO_PILOT, publicação, rollback de edição do marketplace, sincronização multiloja real e relatórios automáticos ainda requerem implementação/teste adicional.
- A classificação dos 365 requisitos está em `docs/AUDITORIA-RECURSIVA-365-REQUISITOS.md` e `AUDITORIA-365-RESUMO.json`. “Implementado no código” não equivale a homologado em marketplace real.
