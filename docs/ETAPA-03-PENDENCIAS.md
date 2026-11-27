# Etapa 03 — pendências e evidências

Atualização: 27/11/2026. Master preservada; candidata 3.12.0 em validation/3.12.0-etapa-03.

## Evidência confirmada
- CI 36 (46008147737): sucesso para captura de notas individuais, atualização de notas ausentes e testes associados.
- CI 37 (46009765182): sucesso para extração conservadora de marcas explícitas de gráficos.
- Commits 1a1e4e8, 430998a e 07f7df1: testes adicionais de gráficos e sinalização/teste de filtros personalizados; CI própria ainda a confirmar nesta revisão.

## Pendências técnicas
- IDs 14, 18, 19, 51–53: paginação SPA fora de anúncios. O coletor geral usa URL como identidade; o serviço rejeita spaPage fora de ADVANCED_LISTINGS. Implementar identidade de página, recibos, retomada persistente e testes de duplicidade e isolamento antes de declarar concluído.
- ID 17: filtros personalizados: detecção conservadora implementada para controles reconhecíveis; restauração automática de widgets arbitrários não implementada. Exigir assinatura verificável e controles inequívocos, sem cliques em formulários de escrita.
- ID 16: gráficos exclusivamente visuais sem valores explícitos não são estimados. Marcas com evidência textual são coletadas parcialmente; não comprovam cobertura integral.
- ID 16: tabelas virtualizadas fora da coleta de anúncios não têm cobertura integral comprovada.
- ID 42: nota de avaliação individual exige identificação da avaliação e evidência explícita; outros formatos permanecem não capturados.

## Homologação real — autorizada para depois
- Chrome e Edge simultâneos com contas reais, instalação Windows, conciliação dos campos 25–48 com relatórios reais, confirmação de filtros, CAPTCHA e identidade de lojas. Não usar credenciais ou operar anúncios reais sem autorização específica.

## Portão de integração
A CI verde não comprova cobertura universal. Não declarar os 34 requisitos integralmente concluídos nem oficializar a candidata enquanto as pendências técnicas acima não forem resolvidas ou explicitamente aceitas como limitações. A etapa 04 está autorizada pelo usuário após resolução técnica ou registro transparente de impedimentos; homologação exclusivamente real pode ser adiada.

## Revisão SPA reativa

- Implementação publicada: adaptadores reconhecem paginação em áreas de leitura; MutationObserver confirma a transição; o worker exige IDs explícitos e estáveis, conserva a conta, filtros e marketplace, usa aba temporária e persiste fingerprint e marcador de cada página. O serviço permite a identidade SPA geral e protege o histórico e os recibos.
- Testes adicionados: retomada sem duplicação, mudança de conta, registros repetidos, SQLite e timeout do observador. CI da revisão final ainda pendente; não considerar aprovada antes de verificar.
- Limites conservadores: início na página 1, somente controles reconhecidos, registros com identidade explícita; métricas de área divergentes, filtros desconhecidos, tabelas sem cobertura comprovada e interfaces sem marcador inequívoco interrompem a coleta. Teste em contas reais continua necessário. Gráficos exclusivamente em pixels não são estimados.
- Esta revisão substitui o diagnóstico anterior de ausência de implementação SPA geral, mas não comprova homologação universal.

## Fechamento de escopo autorizado

Em 27/11/2026 o usuário autorizou a integração e o avanço para a etapa 04, dispensando testes que dependam de utilização real. A dispensa é de portão de entrega, não um resultado de teste. A versão candidata agora é 3.12.0 nos metadados de distribuição.

- SPA reconhecível: motor reativo implementado e aprovado na CI 53; revisões posteriores exigem CI final.
- Aprendizado de navegação: primeira camada aprovada na CI 63; grafo, observações de ações internas, recuperação semântica, filtros listbox, rolagem indexada de feedback e painel adicionados depois. CI 90: 333/334 Vitest aprovados, erro do analisador estático corrigido em 74885ae; executar CI novamente.
- Interfaces sem marcador/ID verificável, seletores arbitrários, widgets desconhecidos e gráficos exclusivamente em pixels permanecem fora da cobertura comprovada. Não interpretar essas limitações como implementação universal; coleta parcial é indicada e ações incertas são recusadas. Não usar APIs privadas ou simular números.
- Homologação real com contas dos marketplaces, Chrome/Edge e Windows: dispensada para a entrega, não executada. Conciliação com relatórios reais permanece recomendada.
- A etapa 04 deve partir da versão integrada, após aprovação dos testes automatizados disponíveis. Não alterar testes para esconder falhas.
