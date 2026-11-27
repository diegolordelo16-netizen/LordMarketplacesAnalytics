# Etapa 03.1 — inteligência de navegação

## Primeira entrega
- Aprendizado voluntário no painel lateral: observa a rota estrutural da aba ativa a cada 2,5 s enquanto o painel permanece aberto. Também permite demonstrar manualmente a página atual. Para quando a conta, aba, origem ou contexto autorizado não coincide.
- Migration 027 e IPC navigation.observe/list/clear, com permissão execute_task e conta ativa verificada. Limite de 100 rotas por conta. Não armazena parâmetros, fragmentos, texto de clientes, cliques ou credenciais.
- A varredura prioriza rotas demonstradas que também aparecem como links autorizados no DOM atual. A memória não autoriza abrir URLs ocultas nem executar ações de escrita.
- Testes de persistência, isolamento, rejeição de entradas inválidas, exclusão e prioridade de links foram publicados. Validar a CI final.

## Próximas entregas (não implementadas nesta revisão)
1. Grafo de transições semânticas e reprodução validada de ações de leitura.
2. Aprendizado de seletores semânticos com candidatos, confirmação e versionamento.
3. Filtros personalizados, paginação sem marcador e virtualização com evidência verificável.
4. Recuperação e pontuação de confiança, diagnósticos e interface no dashboard.
5. Homologação real com Chrome/Edge e contas dos três marketplaces.

A memória de rotas não é um gravador de eventos nem um modelo de IA treinado. Não classificar a subetapa como concluída antes da implementação e validação das próximas entregas. Master preservada.

## Segunda entrega — expansão adaptativa

- CI 63 (46011887499): primeira entrega aprovada.
- Migration 028: grafo de transições demonstradas, vinculado à conta e à origem, máximo de 500 por conta, exclusão em cascata. O motor prioriza transições da página atual somente entre links de leitura reconhecidos e visíveis.
- Migration 029: observações de mudanças SPA (marcador consecutivo e filtro igual) e mudanças de filtros (mesma rota e marcador). Somente tipo e contagem são persistidos, sem valores de filtros. Demonstrações são amostras do contexto a cada 2,5 s, não gravação de cliques.
- Recuperação semântica: rótulos conhecidos de próxima página em uma região de paginação inequívoca. Controles ambíguos, links, formulários e submissões são rejeitados.
- Filtros personalizados: leitura de aria-valuetext/opção selecionada, rejeição de conflitos, restauração de listbox visível com opção única, revalidação de conta, rota e assinatura antes de capturar nas áreas autorizadas.
- Virtualização: extensão da coleta indexada para perguntas, avaliações, reclamações e devoluções com identificadores explícitos. Teto de 200 linhas de feedback, 40 movimentos de rolagem, restauração da posição, cobertura parcial em caso de lacuna.
- Dashboard: resumo por conta, rotas, transições e tipos de ações internas observadas. Não atribui porcentagem de confiança sem evidência.
- Testes novos de grafo, isolamento, exclusão em cascata, filtros, feedback virtualizado e ações internas. CI final ainda pendente no momento deste registro; nenhuma alegação de aprovação da segunda entrega.

## Limites ainda abertos
- Aprendizado de seletores arbitrários/autoalteração de regras e reprodução de cliques não reconhecidos não implementados. O sistema usa semântica previamente permitida e nunca escolhe entre candidatos ambíguos apenas pela memória.
- Paginação sem marcador ou limite inicial/final inequívoco: não implementada. É necessário demonstrar estrutura real e definir uma identidade verificável; não simular um número de página.
- Comboboxes que exigem abrir popups, calendários proprietários, tabelas sem índices ou IDs explícitos e gráficos exclusivamente em pixels: cobertura incompleta.
- Grafo é uma preferência de ordem de coleta, não prova de uma sequência de cliques reproduzível ou permissão para abrir rotas ocultas.
- Homologação real Chrome/Edge e conciliação com exportações reais continuam pendentes; autorizadas pelo usuário para depois. Master preservada, etapa 04 ainda não iniciada.

Esta seção atualiza a lista de próximas entregas anterior; os itens acima descrevem implementação parcial, não conclusão universal.
