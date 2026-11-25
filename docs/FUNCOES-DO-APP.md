# Lord Marketplaces Analytics — lista completa de funções

Versão 0.7.0 · Windows · local first (nada sai deste computador sem a sua ordem)

---

## 1. Como o produto se instala e abre

| Função | Onde |
|---|---|
| Instalador único (`Setup-LordMarketplacesAnalytics-0.7.0.exe`), sem pedir Node, Python ou Git | `release/installer/` |
| Runtime embutido (Node + bibliotecas) — nada é instalado no sistema | `%LOCALAPPDATA%\LordMarketplacesAnalytics` |
| Serviço local sobe sozinho no fim da instalação e abre a página de status | `http://127.0.0.1:47822/` |
| Atalho no menu Iniciar, opcional na área de trabalho e na inicialização | instalador |
| Página de status: endereço do serviço, banco, ID da extensão, Gemini, proprietário, credenciais de API | `:47822` |
| **Gerar token de pareamento** — aparece em campo copiável, com botão **Copiar** | `:47822` |
| **Abrir painel da extensão** — e, se o navegador bloquear, o endereço fica à vista para colar | `:47822` |
| Conserto do ID da extensão pelo próprio navegador (`POST /reparar-extensao`) | `:47822` |
| Banco preservado na desinstalação | `data.db` |

**O que o instalador não consegue fazer sozinho:** o Chrome e o Edge não aceitam
que um programa instale uma extensão de fora da loja. Carregar a pasta
`%LOCALAPPDATA%\LordMarketplacesAnalytics\extension` exige ligar o **Modo do
desenvolvedor** em `chrome://extensions` e clicar em **Carregar sem
compactação** — dois cliques, uma vez. Publicar na Chrome Web Store é o único
caminho para instalar com um clique, e isso exige conta de desenvolvedor
(US$ 5, uma vez) e revisão da loja.

---

## 2. Captura e dados (o coração do produto)

- **Captura pela sua sessão** — lê a página que você abriu, sem pedir senha,
  cookie ou token, e sem chamar API do marketplace.
- **Adapters Mercado Livre e Shopee** — anúncios, preços, pedidos e vendas.
- **Proveniência em cada dado** — fonte, conta, data, método e status
  (`ZERO`, `UNKNOWN`, `NOT_COLLECTED`, `UNAVAILABLE`, `ESTIMATED`, `CALCULATED`, `VERIFIED`).
- **`null` ≠ `0`** — o que não foi lido é “não coletado”, nunca zero.
- **Histórico append-only** — recaptura nunca sobrescreve.
- **Catálogo de anúncios** — `listings` com título, preço e referência.

---

## 3. Painel (aba inteira da extensão)

12 abas em quatro grupos, com tema claro premium e gráficos em SVG puro.

**Operação**
- **Visão geral** — KPIs do dia e gráficos.
- **Missões do dia** — até 5 missões priorizadas (margem negativa, abaixo do
  piso, ruptura, visitas sem venda, concorrente mais barato), com decisão.

**Inteligência**
- **Concorrentes** — cadastro por link ou por código manual em 7 plataformas,
  snapshots, eventos de mudança (preço, vendas, estoque).
- **Descoberta IA** — cadastro do seu produto, busca de concorrentes, fila de
  revisão com aprovar/rejeitar/classificar e indicadores de precisão.
- **Descrição & CRO** — sugestão de descrição com **título imutável** e texto
  original preservado e verificado.
- **Margem & preço** — custo por SKU, margem atual, cenários de preço e piso
  mínimo de 15%.

**Dados**
- **Captura** — dispara e acompanha a leitura da página aberta.

**Governança**
- **Melhorias** — fila de propostas; só o `OWNER_PRINCIPAL` aprova.
- **Auditoria** — trilha encadeada de tudo que o serviço fez.
- **APIs** — credenciais cifradas (AES-256-GCM), segredo nunca volta ao painel.
- **Sistema** — versão, serviço, banco.

Atalho **Alt+Shift+D** abre o painel; clique no ícone da extensão abre o painel
lateral; o botão **⌂ Abrir dashboard** leva ao painel completo.

---

## 4. Inteligência interna (o cérebro)

- Análise determinística e auditável — cada número tem explicação.
- **Gemini é consultor opcional** — audita e responde, nunca decide sozinho,
  com cota diária configurável.
- **Central de melhorias** — a IA propõe, o proprietário aprova; aprovar no app
  ≠ aplicar no marketplace (ação separada).
- **Aprendizado real** — decisões viram ajustes de nota limitados a ±20%,
  aplicados só a produtos da mesma assinatura e mostrados na justificativa.

---

## 5. Descoberta assistida de concorrentes (0.7.0)

1. **Seu produto** — título, marca, modelo, categoria, características
   confirmadas, variações e preço.
2. **Busca** — lê a página de resultados aberta e extrai **vários** anúncios.
3. **Nota explicável** — modelo 32, marca 18, palavras do título 25, categoria
   10, atributos 10, faixa de preço 5, mais o ajuste aprendido.
4. **Relação** — DIRETO, SIMILAR ou INDIRETO, com justificativa em texto.
5. **Revisão humana obrigatória** — toda sugestão nasce PENDENTE; aprovar é o
   único caminho para o monitoramento.
6. **Rejeição com motivo** — registrada, imutável, e pesa na busca seguinte.
7. **Monitoramento** — só depois da aprovação.
8. **Indicadores** — pendentes, aprovados, rejeitados e precisão das sugestões.

---

## 6. Segurança e limites declarados

- Só `127.0.0.1`, com token de curta duração e lista de origens permitidas.
- Nenhum endpoint privado de marketplace, nenhuma burla de CAPTCHA.
- Plataforma sem leitor diz “não coletado” em vez de inventar número.
- Banco e histórico ficam no seu computador; a extensão não envia dados a fora.

---

## 7. O que ainda não existe

- **Leitor de página** para Amazon, TikTok Shop, Magalu, Temu, Shein e Netshoes
  (cadastro e histórico funcionam; coleta avisa que não lê).
- **Assinatura de código** do `Setup.exe` — sem certificado, o SmartScreen
  mostra “aplicativo desconhecido”.
- **Instalação da extensão em um clique** — depende de publicação na loja.
