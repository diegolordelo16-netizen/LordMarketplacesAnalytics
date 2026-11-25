# Como testar a Prova de Conceito (Entrega 2)

Estado atual: **extensão compilada + serviço local + canal loopback com pareamento por token**.
A captura real de anúncios entra na próxima etapa. O que você pode verificar agora está abaixo.

## 1. Subir o serviço local

Abra um terminal na raiz do projeto e rode:

```sh
. ./env.sh
LMA_EXTENSION_ORIGIN="chrome-extension://SEU_ID" pnpm --filter @lma/local-agent dev
```

O serviço imprime o canal e o **token de pareamento**:

```
 canal:  ws://127.0.0.1:47821
 token:  c8271814904f4cd9acd10d89b785915db9f675ff3f9a403ab170b86edd357c31
 expira: em 10 minutos ou no primeiro uso
```

O token vale **uma vez** e expira em 10 minutos. Para gerar outro, reinicie o serviço.

## 2. Carregar a extensão no Chrome

1. Abra `chrome://extensions`
2. Ligue o **Modo do desenvolvedor**
3. Clique em **Carregar sem compactação** e escolha a pasta `apps/extension/dist`
4. Copie o **ID** que aparece no cartão da extensão (ex.: `abcdefghijklmnop...`)
5. Reinicie o serviço local com `LMA_EXTENSION_ORIGIN="chrome-extension://<ID copiado>"`

> O ID muda se a extensão for recarregada de outra pasta. Sem o ID correto o serviço
> recusa a conexão com `ORIGIN_REJECTED` — isso é proposital: não existe curinga.

## 3. Parear

1. Clique no ícone da extensão — o Side Panel abre
2. Confira o endereço do canal (`ws://127.0.0.1:47821`)
3. Cole o token e clique em **Parear**
4. O selo muda para **Pareado**
5. Clique em **Testar ping** → deve aparecer `pong do serviço local v0.1.0`

## 4. Ver o reconhecimento de página

Abra o Mercado Livre ou a Shopee logado na sua conta e olhe o bloco **Aba atual**:

| Campo | O que deve aparecer |
|---|---|
| Marketplace | Mercado Livre / Shopee |
| Página | Painel do vendedor, Lista de anúncios, Estoque, Publicidade, Pedidos… |
| Conta | nome da loja, **ou** “não legível nesta página” |
| Confiança | `high`, `medium` ou `low` |

Se aparecer “não legível”, é o comportamento correto — o painel não inventa conta.

## 5. Recompilar depois de qualquer alteração

```sh
. ./env.sh
pnpm --filter @lma/extension build
```

Depois clique em **Atualizar** no cartão da extensão em `chrome://extensions`.

## 6. Rodar todos os testes

```sh
. ./env.sh
pnpm -r test
```

Esperado: **126 testes** verdes (protocolo 9, extensão 16, serviço local 14 + 85 no runner do Node, integração 2).

## 7. Usar o pacote portátil (sem Node instalado)

```sh
node scripts/package-windows.mjs
```

Abra `release/LordMarketplacesAnalytics/start.cmd` com duplo clique. Ele usa o
`runtime/node.exe` embutido. Para o usuário final, o zip em `release/` basta.

## O que está implementado

- Captura da lista de anúncios do Mercado Livre e de produtos da Shopee (DOM → dados tipados)
- Captura de pedidos nos dois marketplaces e cruzamento venda × estoque
- Persistência em SQLite com proveniência obrigatória
- Alertas determinísticos (estoque zero, baixo, variação de preço)
- Plano do cérebro (IA interna), com pontos cegos declarados
- Auditoria opcional pelo Gemini, com cota local
- Central de Melhorias com aprovação exclusiva do proprietário
- Pacote Windows portátil com runtime embutido

## O que ainda NÃO está implementado

- Captura de pedidos, estoque central e publicidade
- Instalador `Setup.exe` assinado
- Native Messaging (depende de extensão publicada com ID fixo)

Nenhuma dessas ausências é silenciosa: a interface mostra apenas o que existe.

## Novidades da versão 0.6.0

**Concorrentes por link.** Cole o link do anúncio em *Concorrentes → Adicionar concorrente por link*.
O marketplace é identificado pelo próprio link, sem chamar nada para fora. Depois de salvar, abra o
anúncio no navegador, volte ao dashboard e clique em **Coletar**: a sua sessão lê a página e a leitura
vira um snapshot datado. A partir da segunda leitura o sistema detecta mudança de preço, avanço de
vendas e saída de estoque. A primeira leitura nunca gera alerta — não há com o que comparar.

**Edição de descrição.** Em *Descrição & CRO*, escolha o anúncio, cole a descrição atual e informe os
dados confirmados do produto (uma linha por campo). O sistema propõe acréscimos com motivo e fonte e
mostra original × complementada. O título não muda: não existe campo de título novo no banco e o
serviço recusa qualquer proposta que perca texto do original. O que falta vira lacuna para você
preencher — a IA não inventa característica.

**Margem e preço.** Em *Margem & preço*, cadastre custo, embalagem, comissão, imposto, taxa fixa,
frete e margem mínima. Sem custo cadastrado a margem aparece como "sem custo" — nunca como zero.
Os cenários de preço mostram em quais valores a margem mínima é violada.

**Missões do dia.** Depois de coletar anúncios e pedidos, clique em *Gerar missões*. No máximo cinco
ações, cada uma com gargalo, hipótese, evidência numérica, impacto, esforço, urgência e risco.
