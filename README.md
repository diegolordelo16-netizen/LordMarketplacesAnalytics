# Marketplace Intelligence & Autonomous Operations

Plataforma Local First de inteligência e operações para marketplaces. Funciona sobre dados visíveis na sessão autenticada do vendedor e no banco local. Não lê cookies/tokens do marketplace nem chama endpoints privados.

## Versão 3.10.8

No dashboard, abra **Extensão & Coletas** para consultar a conexão, solicitar uma coleta, acompanhar páginas, agendar rotinas e repetir contas com falha. A extensão executa a leitura nas abas de vendedor abertas. A seção **Conectores** aceita PDF digital para conferência e oferece configuração e teste de leitura para GA4 e Search Console.

[Resultados dos testes e cobertura](DEBUG-3.10.8.md)

### 3.10.7 — retomada segura de coleta por página

- Cada página concluída é registrada em `sync_batch_page_runs`; o lote persiste cursor atual, URLs visitadas e links pendentes com domínio HTTPS validado.
- Após encerramento do worker durante lote agendado, a recuperação do lease retoma dos links pendentes e pula páginas já confirmadas.
- O painel mostra a página atual e o progresso de cada conta em tempo real. URLs são sanitizadas; somente parâmetros de paginação conhecidos são preservados.

### 3.10.6 — painel administrativo e central de sincronização

- Área administrativa `super_admin`: criar usuários, ajustar papéis (`super_admin`, `operador`, `visualizador`), ativar/desativar e revogar sessões. O serviço protege o último administrador e impede auto-desativação.
- Agendas de análise e relatórios têm criação, pausa/reativação, recorrência fixa ou personalizada (15–43200 minutos), histórico persistido e download JSON.
- Coletas recorrentes podem ser agendadas para contas ativas, marketplaces habilitados ou uma conta específica: por hora, 6 horas, diariamente, semanalmente ou intervalo personalizado (15–43200 minutos).
- O worker da extensão processa um lote por vez quando o navegador está ativo e só usa abas autenticadas cuja identidade visível coincide exatamente com a conta; não alterna sessões.
- Painel mostra progresso por conta/páginas, histórico de lotes e permite repetir manualmente contas FAILED/PARTIAL/SKIPPED elegíveis em um novo lote auditável.
- Janelas perdidas são puladas sem execução acumulada; falhas usam retentativas de 5, 15 e 60 minutos antes de voltar à próxima ocorrência normal.
- A fila exibe progresso por estado e permite atualização manual.
- Importação de PDF digital usa Poppler/pdftotext opcional quando disponível, com limites de processo; o parser interno é fallback. Não há OCR e tabelas/colunas precisam de revisão.
- Smoke offline: `npm run smoke:local` (Node 22.13+), sem depender de Vitest.

A sincronização agendada não executa com o navegador fechado, sem extensão ativa ou sem aba de vendedor autenticada correspondente; contas sem correspondência são ignoradas. Isso não é uma integração API em background.

A matriz da versão 3.10.8 possui 188 itens implementados no código, 3 validados localmente e 174 parciais. [Matriz de requisitos](docs/AUDITORIA-RECURSIVA-365-REQUISITOS.md)

### Histórico 3.10.2

A 3.10.2 acrescentou capacidades locais para reclamações e motivos de devolução visíveis no Mercado Livre/Shopee; sincronização por contas identificadas nas abas abertas; lucro realizado por conciliação de valores informados; evidência visível de frete, prazo, patrocinado e imagens; propostas locais de campanhas/ofertas; modos operacionais; agendamento e importação de PDF digital para staging.

**Limites preservados:** modos automáticos executam análises e sugestões; não publicam campanhas/ofertas. A comparação de imagens só identifica hashes idênticos quando fornecidos, sem medir similaridade visual. PDFs digitalizados/OCR e CMaps não são suportados. A migration 012 registra marketplaces e conectores no catálogo, mas nenhum conector é considerado conectado sem OAuth/API homologado.

### 3.10.3 — publicação assistida sob controle humano

O requisito 284 deixou de estar ausente no código: agora existe uma sequência `DRAFT → aprovação administrativa → execução na aba ativa → verificação → registro`. Somente `super_admin` autoriza, reivindica e registra uma publicação; são aceitos até 10 anúncios da mesma conta e marketplace por lote, com frase `PUBLICAR N`, justificativa, autorização de 15 minutos e consumo único. Antes de preencher o rascunho, a extensão captura o estado original; o serviço persiste esse snapshot vinculado à conta, ao anúncio e à URL de origem. A publicação exige conta/sessão/anúncio exatos, confirmação nativa separada por item, um único botão de salvar inequívoco e mensagem positiva nova na página, além da leitura posterior do campo alterado. Sem prova, o estado vira incerto e não é repetido automaticamente. O rollback cria um novo rascunho de título; não faz gravação remota automática.

**Limites:** o fluxo é código preparado para Mercado Livre e Shopee, mas seletores e mensagens precisam de homologação em contas reais. Não há OAuth/API oficial, publicação em background, Ads/campanhas, duplicação, troca de imagens ou rollback remoto automático. O rollback assistido está limitado a título; descrição exige revisão manual.

## Verificação

O relatório registra a suíte automatizada, os builds, a integridade do SQLite e o teste em Chrome e Edge com páginas simuladas.

## Instalar (usuário final)

1. Extraia o ZIP e, no Chrome, abra `chrome://extensions` (ou `edge://extensions` no Edge).
2. Ative o **Modo do desenvolvedor** e selecione **Carregar sem compactação**.
3. Escolha a pasta `dist/extension` do projeto.
4. Para executar o agente local/Native Host, instale as dependências com `npm ci` e rode os builds abaixo. O instalador Windows `.exe` não está incluído nesta versão; reconstrua-o com `npm run package:win` em Windows com Inno Setup 6.

## Desenvolvimento

Requer Node.js **22.13.0 ou superior**.

```bash
npm ci
npm run typecheck
npm test
npm run agent:build
npm run host:build
npm run ext:build
npm run db:generate -- --check
npm run audit:publish
npm run audit
```

## Regras invioláveis

- Ausente ≠ zero: campo não lido permanece `NOT_COLLECTED`/`UNKNOWN`.
- Estimativa nunca é apresentada como dado real.
- Lucro realizado só usa valores identificados e evidência da origem.
- Propostas de campanhas/ofertas não são publicadas automaticamente.
- Ação sensível exige aprovação humana e registro no `audit_log`.
