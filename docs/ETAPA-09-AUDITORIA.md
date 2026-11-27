# Etapa 09 — relatórios e administração — 3.18.0 candidata

Base: etapa 08, 3.17.0, CI 264 aprovada (6a903d03). PR empilhado sobre a branch da etapa 08; master não alterada.

## Matriz 306–325
- 306: executivo com resumo, escopo, janela de captura, cobertura e exportação paginada.
- 307: KPIs preservam entidade conta/anúncio, métricas, evidência e filtros.
- 308: financeiro distingue custo cadastrado de resultado realizado, calcula lucro/margem por registro confirmado; resumo rejeita conflitos e não agrega lojas.
- 309: relatório dedicado por anúncio com SKU, observação mais recente e KPIs; janela de negócio não inferida como verificada.
- 310: concorrência preserva relações, revisão, monitoramento, similaridade e origem. Janela por sugestão, não por venda.
- 311: auditoria global restrita a administrador, filtro de período e paginação por limite de ID; exportação omite payloads antes/depois.
- 312–314: CSV com proteção contra fórmulas e metadados, XLSX com abas Escopo/Resumo/Dados, JSON estruturado; sem dependências externas.
- 315: arquivo PDF de múltiplas páginas gerado pelo serviço, com fonte WinAnsi, metadados e campos completos da parte; limita volume explicitamente. Caracteres fora de WinAnsi são substituídos por "?"; não requer navegador/Poppler para gerar.
- 316–318: backup consistente, lista e restauração confirmada existentes, mantidos.
- 319–320: trilha de operações/auditoria, antes/depois para mudanças de anúncios e histórico de limites.
- 321: reversão assistida de título por tarefa DRAFT, ID interno correto, sem replay; estado original marcado revertido somente após publicação inversa verificada. Descrição integral exige procedimento manual (executor existente acrescenta texto, não substitui integralmente); outras alterações sem executor seguro não são marcadas revertidas. Limites financeiros locais podem ser restaurados por revisão com comparação de estado atual.
- 322–323: gestão Gemini e remoção local confirmada, consumo/limites estimados em 24h.
- 324: diagnóstico selecionável para os três marketplaces.
- 325: perfis existentes e gestão de usuários, autorização IPC, configuração/registro/restauração de limites por campanha e variação. Não há teto global de campanha verificado sem cobertura externa. 
- Agendamentos de relatório verificam usuário responsável ativo e papel; auditoria não é acessível a visualizador/operador. Relatórios muito grandes são paginados e identificados como parciais; nova exportação após alterações concorrentes pode ter recorte diferente.
- Testes de publicação simulam resposta do marketplace; não substituem homologação real. 
- CI 269: TypeScript, builds, testes e regressões passaram; auditoria estática antiga esperava texto de rollback obsoleto, ajustada para exigir o vínculo e prova inversa. Nova CI deve validar SHA final.

## Revisão adicional
Relatórios agendados passaram a armazenar as partes da mesma transação local (até 100 partes e 20 MB, com indicação explícita de parcialidade), em vez de descartar dados acima de 1 MB. O download reúne todas as partes armazenadas; arquivos legados permanecem legíveis.
