# LordMarketplacesAnalytics 3.10.5 — relatório de implementação

**Data:** 27/11/2026  
**Base:** pacote 3.10.3, com incrementos locais 3.10.4 e 3.10.5  
**Foco:** reduzir requisitos parciais da central de sincronização com funcionalidades verificáveis offline.

## 1. Etapas desta rodada

### Etapa A — auditoria da matriz

A matriz oficial foi recontada e validada por IDs únicos: 365 requisitos. Antes desta rodada, o resumo era de 176 implementados no código, 189 parciais/não comprovados e zero ausentes. Os itens 54–59 estavam parciais porque parte do agendamento existia no serviço, mas faltavam o ciclo de coletas persistente, o worker agendado e o painel de progresso/histórico.

### Etapa B — agendamento recorrente das coletas

Foi criada a migration `016_sync_schedules.sql`, com:

- `sync_schedules`: escopo, conta opcional, cadência, intervalo customizado, ativação, próxima execução e último resultado;
- `sync_schedule_runs`: histórico com lote associado, início/fim, estado, resumo e erro;
- índices para busca de agendas vencidas e histórico pendente.

O serviço local agora aceita os escopos `ALL_ACTIVE_ACCOUNTS`, `ALL_ENABLED_MARKETPLACES` e `ACCOUNT`. Cadências fixas: 1 hora, 6 horas, diária e semanal. Cadência customizada: 15 a 43200 minutos.

O agendador cria lotes locais duráveis, não captura conteúdo por conta própria. A extensão MV3 consulta um alarme a cada minuto e reivindica um lote pendente por vez. O lote só é processado se o Chrome/Edge e a extensão estiverem ativos e houver aba do vendedor já autenticada cuja identidade visível coincida exatamente com a conta registrada.

Não há troca de sessão. Uma conta sem aba correspondente recebe `SKIPPED`. Quando o navegador está fechado, nenhuma captura ocorre; o lote aguarda a extensão ativa. O worker pode recuperar uma execução `RUNNING` parada há mais de 30 minutos. Contas terminais já processadas são puladas na recuperação, e o serviço reconcilia o histórico caso o worker caia entre a atualização do lote e a agenda.

### Etapa C — painel e progresso

O painel lateral agora permite:

- agendar todas as contas ativas, marketplaces habilitados ou uma conta individual;
- escolher cadência horária, 6 horas, diária, semanal ou intervalo personalizado;
- ativar/pausar agendas e consultar seu histórico;
- consultar os 30 lotes recentes, incluindo os criados manualmente;
- acompanhar progresso por conta e páginas durante uma execução através de mensagens `MI_SYNC_PROGRESS`.

### Etapa D — repetição controlada de falhas

Foi adicionado `sync.retryFailed`. A ação exige um lote original em estado `PARTIAL` ou `FAILED` e cria um novo lote auditável somente com contas ativas em estado `FAILED`, `PARTIAL` ou `SKIPPED`. Contas já presentes em outro lote `QUEUED`/`RUNNING` são excluídas para evitar duplicação.

A interface oferece repetição manual para lotes parciais/falhos. A repetição continua condicionada ao navegador ativo e à aba autenticada da conta correta. Não existe retentativa automática em background; o retry é uma decisão explícita do operador.

### Etapa E — contratos e permissões

Os métodos `sync.schedule.create/list/setEnabled/runs`, `sync.claimScheduled` e `sync.retryFailed` foram declarados no contrato IPC, registrados no serviço e associados às permissões correspondentes. O endpoint de retry registra auditoria e identifica o lote anterior no resumo do novo lote.

## 2. Requisitos promovidos

Foram promovidos apenas os requisitos **54, 55, 56, 57, 58, 59 e 62**:

- 54 — agendar coleta por hora;
- 55 — agendar coleta a cada 6 horas;
- 56 — agendar coleta diária;
- 57 — agendar coleta semanal;
- 58 — criar intervalos personalizados;
- 59 — mostrar progresso da coleta.

A promoção é de implementação em código, não de homologação em contas reais. O requisito 62 foi promovido como implementado no código, pois o retry manual possui método IPC protegido, UI nos lotes recentes/histórico, filtro de contas ativas elegíveis, bloqueio de duplicação e smoke SQLite. O teste em sessão real continua pendente, assim como para a maioria das integrações de captura. Os requisitos 51–53 permanecem parciais por dependerem da cobertura efetiva de dados e áreas visíveis em cada conta/marketplace.

## 3. Classificação atual dos 365 requisitos

| Estado | Quantidade |
|---|---:|
| Implementado no código | 183 |
| Parcial ou não comprovado | 182 |
| Não implementado/não funcional | 0 |
| **Total** | **365** |

Não foram promovidos itens que dependem de OAuth, APIs externas, credenciais, sessão de vendedor ou prova de execução em Chrome/Edge real.

## 4. Limitações conhecidas

- Coleta agendada requer navegador/worker da extensão ativos.
- Requer abas de vendedor abertas e autenticadas; ausência resulta em `SKIPPED`.
- Não há troca automática de sessão nem acesso a cookies/tokens privados.
- Não há conexão OAuth/API oficial homologada nesta execução.
- Retry de falhas é manual e cria um lote novo; não é uma fila autônoma infinita.
- Não foi executado teste com contas reais nem teste de Chrome/Edge automatizado.
- Vitest, typecheck semântico e builds do agente/Native Host continuam bloqueados por dependências npm ausentes no ambiente.

## 5. Arquivos principais alterados

- `packages/local-agent/migrations/016_sync_schedules.sql`
- `packages/local-agent/src/service.ts`
- `packages/shared/src/types/contracts.ts`
- `packages/extension/service-worker.js`
- `packages/extension/panel/panel.html`
- `packages/extension/panel/panel.js`
- `contracts.json`
- `scripts/smoke-local-features.mjs`
- `scripts/audit-project.mjs`
- `docs/AUDITORIA-RECURSIVA-365-REQUISITOS.md`
- `AUDITORIA-365-RESUMO.json`

Consulte `DEBUG-3.10.5.md` para os comandos executados e bloqueios reproduzidos.
