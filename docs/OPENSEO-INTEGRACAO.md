# Integração OpenSEO — Etapa 06

Origem: https://github.com/every-app/open-seo/tree/6f68494e92a695db17f4b22da25e84b9bf1e582c (MIT, copyright 2026 Ben Senescu). Licença integral em third-party/open-seo/LICENSE. Normalização de intenção reaproveitada de src/server/features/keywords/services/research/helpers.ts; contratos de requisição adaptados de src/server/lib/dataforseo/{labs,serp,backlinks}.ts. O projeto é alternativa ao Semrush, não API nem homologação Semrush.

## Operação
No ambiente do processo do agente local, configure MI_DATAFORSEO_LOGIN e MI_DATAFORSEO_PASSWORD com as credenciais API DataForSEO. Exemplo PowerShell para uma sessão de desenvolvimento: `$env:MI_DATAFORSEO_LOGIN = Read-Host "Login API"`; configure a senha por meio do gerenciador seguro de ambiente de sua instalação, sem incluí-la em arquivos versionados. Reinicie o agente nesse ambiente. No painel SEO & Keywords, use Pesquisa SEO externa e confirme cada consulta tarifada. Somente super_admin pode executar. Não há agendamento ou retentativa após falha de transporte. A resposta indica custo reportado em USD, que pode ser desconhecido. Não há teto garantido de cobrança: configure limites e saldo no provedor.

Modos: sugestões, relacionados, ideias, SERP Google (10 posições solicitadas), palavras-chave de domínio concorrente, visibilidade de domínio e resumo de backlinks. Google Brasil/português (2076/pt); backlinks globais. Até 100 linhas, apenas uma chamada por clique, sem clickstream tarifado adicional. Valores ausentes permanecem nulos; não são importados como volume interno do marketplace. Registra auditoria de custo/estado sem credenciais.

Não incluídos: histórico persistente de consultas, agendamento de ranking Google, análise de backlinks individual, auditoria de site, visibilidade em IA, infraestrutura e interface completas do OpenSEO. A autenticação real e o contrato do provedor em produção exigem credenciais/saldo e não foram homologados. Integração isolada na branch de etapa 06, sem alterar master ou PR 5.

Também apresenta volume mensal mais recente e variação percentual quando há dois meses consecutivos válidos, sem preencher lacunas.

## Expansão de módulos
Foram adaptados os contratos OpenSEO Labs (overview, serp_competitors, relevant_pages), backlinks (lista, domínios, páginas), Lighthouse (resumo de categorias, métricas e problemas numéricos) e AI Optimization (menções de domínio em Google BR/pt ou ChatGPT EUA/en; não é consulta ao modelo desta sessão). SERP aceita localização canônica opcional. Respostas limitadas a 16 MiB. Escopos separados. A lista não equivale a uma reprodução integral do OpenSEO.

## Histórico e monitoramento
Migration 042 cria tabelas isoladas por conta, guarda estado e custo inclusive desconhecido antes/depois do envio, sem credenciais. Comparação de amostras de ranking do mesmo escopo e até 7 dias de diferença; ausência na amostra não significa ausência no ranking. Agrupamento lexical com aderência ao catálogo e sinal exploratório, não substitui score interno, margem ou conversão. Monitoramento Google usa o agendador existente, requer super_admin, confirmação de até 30 consultas por monitoramento, intervalo mínimo de um dia, credenciais de ambiente e MI_DATAFORSEO_ENABLE_SCHEDULES=true. Cada ciclo reserva uma chamada antes do envio; falhas desativam e não há retry/catch-up. Limite de chamadas não garante teto em USD. Nenhuma consulta real foi executada.
