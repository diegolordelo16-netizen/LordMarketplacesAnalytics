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

Esperado: **37 testes** verdes (protocolo 9, extensão 12, serviço local 14, integração 2).

## O que ainda NÃO está implementado

- Captura de anúncios (DOM → dados) e gravação em SQLite
- Persistência com proveniência
- Adapter completo do Mercado Livre e da Shopee
- Native Messaging (só depois de publicação com ID fixo)

Nenhuma dessas ausências é silenciosa: a interface mostra apenas o que existe.
