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
