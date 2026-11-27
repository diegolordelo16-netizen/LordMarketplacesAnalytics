# LordMarketplacesAnalytics 3.10.6 — relatório consolidado de upgrade

**Data:** 27/11/2026  
**Base:** código 3.10.3 + ciclos locais 3.10.4, 3.10.5 e 3.10.6.  
**Objetivo:** reduzir requisitos parciais com implementação verificável e auditoria repetida.

## Etapa 1 — agendamento confiável de análises e relatórios (3.10.4)

- Agendamento de análises e relatórios com recorrência fixa ou personalizada (15 a 43200 minutos).
- Histórico persistente, pausa/reativação, execução de relatório JSON sob demanda e avanço temporal sem drift.
- Retentativa com backoff 5/15/60 minutos; no máximo três retentativas depois da primeira tentativa.
- Progresso da fila e importação de PDF digital com Poppler opcional, sem OCR.

## Etapa 2 — agendamento da coleta e repetição auditável (3.10.5)

- Novas tabelas `sync_schedules` e `sync_schedule_runs` na migration 016.
- Escopo: todas as contas ativas, marketplaces habilitados ou uma conta específica.
- Cadências: horária, 6 horas, diária, semanal ou customizada (15–43200 minutos).
- Alarme da extensão a cada minuto para reivindicar lote durável criado pelo serviço.
- Execução somente com navegador/worker ativo e aba do vendedor já autenticada cuja identidade visível corresponda exatamente à conta; não troca sessões.
- Histórico por agenda, lotes recentes e progresso por conta/páginas via `MI_SYNC_PROGRESS`.
- Recuperação de lease após 30 minutos e reconciliação de lote/history em caso de encerramento do worker.
- `sync.retryFailed` cria um lote novo e auditável com contas ativas FAILED/PARTIAL/SKIPPED, excluindo contas já em outro lote QUEUED/RUNNING. O retry é manual.

## Etapa 3 — administração de usuários no painel (3.10.6)

O requisito **2 — Controle de usuários e permissões** foi completado no código: a área administrativa, exibida apenas quando `auth.session` confirma `super_admin`, permite:

- listar usuários e seus estados;
- criar usuário com nome, e-mail, papel e senha inicial de pelo menos 10 caracteres;
- mudar papéis entre `super_admin`, `operador` e `visualizador`;
- ativar/desativar usuários.

O serviço continua impondo `manage_users` em cada chamada. As proteções não dependem apenas da interface: o servidor impede a auto-desativação, impede desativar ou rebaixar o último `super_admin` ativo, revoga sessões ao desativar um usuário e guarda hash/salt da senha, não senha em texto. Ao editar o próprio papel, o painel atualiza a sessão antes de continuar mostrando a área administrativa.

O smoke SQLite testa papéis válidos, rejeição de papel inválido e e-mail único. A auditoria estática verifica os handlers, IPC, contrato, permissão e controles de último administrador.

## Requisitos promovidos nesta sequência

- **2:** controle de usuários e permissões.
- **54–59:** agendamento de coleta por hora/6h/diário/semanal/customizado e exibição de progresso.
- **62:** repetição manual de coleta com falha em novo lote auditável.
- **256 e 258:** agendamento de análises e relatórios.

## Classificação da matriz

| Estado | Quantidade |
|---|---:|
| Implementado no código | **184** |
| Parcial ou não comprovado | **181** |
| Não implementado/não funcional | **0** |
| **Total** | **365** |

“Implementado no código” não significa homologado em marketplace real. Os 181 restantes incluem cobertura incompleta de dados/áreas, recursos que exigem OAuth/APIs e itens não homologados no Chrome/Edge com vendedor autenticado.

## Limitações que permanecem

- Coletas agendadas não executam com o navegador/worker fechados.
- Sem aba de vendedor autenticada com a identidade exata, a conta é `SKIPPED`.
- Não há troca automática de sessões, leitura de cookies/tokens ou chamadas a endpoints privados.
- A ação de retry é manual, não uma retentativa ilimitada em background.
- Não há credenciais OAuth/API ou conta real de vendedor fornecidas nesta sessão.
- Ainda não foi possível executar Vitest, typecheck semântico, builds de Agent/Native Host ou instalador Windows, porque faltam dependências/npm e Inno Setup no ambiente.
- Não foi feita homologação em Chrome/Edge real nem publicação real de anúncios.

Veja `DEBUG-3.10.6.md` para comandos, resultados e bloqueios reproduzíveis; a matriz completa está em `docs/AUDITORIA-RECURSIVA-365-REQUISITOS.md`.
