# Auditoria de escopo — o que existe hoje e o que falta

Comparação entre o que o software faz **hoje, verificado no código**, e a especificação
v3.1 (Marketplace Intelligence & Autonomous Operations). Documento honesto: só aparece
como pronto o que tem código, handler e teste.

## Retrato do produto hoje (v0.5.0)

| Camada | O que existe |
|---|---|
| Extensão MV3 | Side panel + dashboard em aba inteira (8 seções), content script com captura de HTML, detecção de página ML/Shopee, service worker com canal |
| Serviço local | 19 handlers, SQLite com 10 tabelas, auditoria com hash encadeado |
| Adapters | Mercado Livre (anúncios), Shopee (produtos), pedidos (ambos) |
| Motores | KPIs de listagem, venda × estoque, cérebro determinístico (recomendações + pontos cegos), Central de Melhorias com aprovação do proprietário |
| IA | Gemini opcional (auditoria), com cota diária e autorizações extraordinárias |
| Credenciais de API | 5 marketplaces, AES-256-GCM, segredo nunca volta ao painel, status PENDING/ACTIVE |
| Instalador | Inno Setup por usuário, ID de extensão calculado, banco preservado na desinstalação |

Testes: 135 verdes.

## O que a especificação pede e não existe — por fase

### Fase 1 — Fundação
- [ ] **Native Messaging Host** (hoje o canal é WebSocket em loopback; falta o executável nativo e o registro no Registry para Chrome e Edge)
- [ ] **Perfis de acesso** (`super_admin`, `operador`, `visualizador`) — hoje existe só `OWNER_PRINCIPAL`
- [ ] **Backup automático do SQLite** pré-alteração e restauração
- [ ] **Importação CSV/XLSX** de relatórios do usuário
- [ ] **Data Intelligence completo**: hierarquia de fontes A_PRIMARY_UI … G_UNAVAILABLE (hoje existe só o eixo de qualidade ZERO/UNKNOWN/NOT_COLLECTED/…)
- [ ] Adapters **Amazon, TikTok Shop, Shein, Netshoes**

### Fase 2 — Dados e rentabilidade
- [ ] **Botão "Atualizar dados do dia"** (navegação controlada por várias telas)
- [ ] **Snapshots comparáveis** Hoje/Ontem/7/30/90 dias
- [ ] **Motor financeiro** (custo, comissão, taxa fixa, frete, imposto, Ads, cupom, devolução, margem mínima) — não existe
- [ ] **Simulador de margem e cenários**
- [ ] **Ranking Impacto × Esforço** e **Missões do Dia** (hoje há alertas e recomendações, não o score)

### Fase 3 — Search & Market Intelligence
- [ ] Banco de palavras-chave, clusters, keyword gap, rank tracker, share of visibility
- [ ] Radar de categoria, tendências, product opportunity matrix
- [ ] Correspondência do mesmo produto por SKU/EAN/modelo/marca
- [ ] Radar de concorrentes e linha do tempo de eventos

### Fase 4 — Growth & Experimentos
- [ ] North Star e árvore de métricas
- [ ] Growth backlog (RICE/ICE), growth loops
- [ ] Voice of Customer (avaliações, perguntas, motivos de devolução)
- [ ] Coortes, recompra, atribuição, incrementalidade
- [ ] Experiment registry com amostra, MDE, significância, SRM, análise sequencial

### Fase 5 — Automação e agentes
- [ ] **Task Builder** com execução real (editar título/descrição/capa no anúncio)
- [ ] **Teclado virtual** com validação de texto digitado
- [ ] **Duplicador de anúncios** (variantes B/C)
- [ ] **Automation Guard** (10 requisitos antes de agir)
- [ ] **14 agentes especializados + AI Director**
- [ ] **Workspace de debate com Gemini**
- [ ] **Auto-Upgrade governado** com sandbox, testes, snapshot e rollback
- [ ] Scheduler persistente com `WAITING_BROWSER` e retomada
- [ ] Base de aprendizado anti-devolução com redução progressiva de chamadas ao Gemini

### Fase 6 — Omnichannel
- [ ] GA4, Search Console, Google Trends, Clarity, Semrush/Ahrefs/Similarweb
- [ ] Loja própria (Shopify/Wake), auditoria SEO técnica
- [ ] Visibilidade em mecanismos de IA

## O que não dá para prometer
- **Automação de escrita nos marketplaces** (editar anúncio, subir capa) exige leitura e
  digitação reais nos editores de cada plataforma; cada uma muda o layout sem aviso, e o
  risco de quebrar um anúncio do usuário é alto. Precisa ser feito com Automation Guard,
  prévia obrigatória e rollback validado — não com "aplicar direto".
- **Vendas de concorrente**: sem fonte legítima, o produto não estima. A especificação
  exige método, intervalo e confiança; estimativa fraca não deve existir.
- **Volume de busca interno do marketplace**: o produto só registra sinal de demanda
  observado (autocomplete, ranking), nunca "volume" como número do marketplace.

## Próximo passo recomendado
A base já funciona ponta a ponta (captura → banco → KPI → recomendação → aprovação →
instalador). O que dá mais resultado por esforço, na ordem:

1. **Motor financeiro + margem por SKU** — sem isso nenhuma recomendação de preço ou Ads é honesta.
2. **Missões do Dia com Impacto × Esforço** — transforma o que já existe em decisão.
3. **Botão "Atualizar dados do dia"** — hoje a captura é página por página.
4. **Palavras-chave e radar de concorrência** — a maior lacuna de valor percebido.
5. **Task Builder + Automation Guard + teclado virtual** — o salto de automação, o mais arriscado.
