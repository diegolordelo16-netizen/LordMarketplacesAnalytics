# Marketplace Intelligence — correções da auditoria

Data: 26/11/2026  
Base analisada: `LordMarketplacesAnalytics-master.zip`

## Correções aplicadas

1. **Autorização IPC com negação por padrão**
   - Cada método IPC protegido passou a ter uma permissão explícita.
   - Métodos sem política são negados, em vez de passar livremente.
   - Cobertura conferida: 77 métodos registrados; 72 com permissão, 4 públicos e `auth.logout` exigindo sessão autenticada.
   - Permissões específicas separadas para contas, concorrentes, inteligência de mercado, experimentos e alertas; operador e visualizador não recebem essas capacidades administrativas.
   - O logout também verifica que a sessão pertence ao usuário autenticado.

2. **Proteção da recuperação do token local**
   - `/api/token` só entrega o token ao painel na origem exata ou à extensão com ID permitido.
   - Para chamadas same-origin sem cabeçalho `Origin`, exige Fetch Metadata `same-origin` e o `Host` exato do painel.
   - Origens arbitrárias de `localhost` e de outras portas deixam de ser aceitas.
   - `/api/token/rotate` exige origem confiável e o Bearer token atualmente válido. A rotação cria uma sessão real, revoga a anterior no serviço (inclusive para Native Messaging) e sincroniza o token do launcher somente após sucesso.
   - A rotação cria uma sessão IPC real e revoga a sessão antiga também no serviço, impedindo reaproveitamento pelo Native Messaging.

3. **Receita líquida sem inferência indevida**
   - Adicionado campo opcional `netRevenue` à entrada e ao schema de captura.
   - O KPI `netRevenue` agora usa somente esse campo explícito; não copia GMV/faturamento bruto.
   - Quando a fonte não fornece receita líquida, o KPI fica indisponível (`null`) e aparece como campo faltante.

4. **Cálculo financeiro**
   - Ponto de equilíbrio separado do piso de margem mínima.
   - Os dois cálculos consideram desconto e perdas esperadas de devolução/cancelamento.
   - A margem unitária considera taxa fixa do marketplace.
   - O corredor bloqueia a recomendação se o piso de margem ultrapassar o limite máximo de aumento autorizado; não retorna preço abaixo do piso.

5. **Captura Mercado Livre/Shopee**
   - Tipos de página enviados pela extensão alinhados ao enum aceito pelo serviço (`product_detail`, `seller_listings`, `seller_dashboard`, `seller_orders`, `seller_ads`, etc.).
   - Corrigida a condição que ainda procurava o antigo `listing_list` e impedia a leitura real da lista de anúncios do Mercado Livre.
   - Corrigido o diagnóstico `missing`, que comparava chaves internas diferentes das chaves usadas em `evidence`.
   - Shopee não classifica mais impressão genérica como impressão orgânica sem evidência explícita.

6. **Dashboard**
   - Totais de valores monetários convertidos de reais para centavos antes de chegar à interface.
   - Foram adicionados os campos agregados usados pela tela (GMV, receita líquida, gasto Ads, CVR, ticket médio, ACoS, ROAS, devoluções e cobertura de estoque).
   - Valores agregados ficam `null` quando os dados de origem são incompletos ou quando há anúncios sem snapshot recente; a cobertura informa capturados e não capturados.
   - Contribuição e margem de contribuição permanecem indisponíveis enquanto o snapshot não possuir custos financeiros suficientes; não são estimadas como se fossem valores reais.

## Verificação das fórmulas de Ads

No código-fonte recebido, ACoS e TACoS já estavam separados corretamente:
- ACoS = gasto Ads / receita atribuída a Ads × 100.
- TACoS = gasto Ads / faturamento total × 100.

Por isso, essas fórmulas não foram alteradas.

## Validações executadas neste ambiente

- Sintaxe JavaScript: todos os arquivos `.js` e `.mjs` verificados com Node.js.
- Sintaxe TypeScript: 48 arquivos processados pelo compilador TypeScript sem erros de parse.
- Manifesto da extensão: JSON válido.
- Runtime financeiro: testes executáveis para ponto de equilíbrio, piso de margem com desconto/perdas e bloqueio de corredor — aprovados.
- Runtime do servidor HTTP: recuperação do token, bloqueio de origem sem metadados, bloqueio de outra porta localhost, extensão autorizada e rotação autenticada — aprovados.
- Captura no navegador: classificação de páginas Shopee e diagnóstico de campos — aprovados.
- Política IPC: cobertura estática dos 77 métodos registrados — sem método protegido sem regra.

## Validação pendente

A instalação das dependências do projeto (`npm ci`) não terminou porque o registro npm não respondeu dentro do limite do ambiente. Assim, a suíte Vitest completa e o `npm run typecheck` não puderam ser executados aqui. Devem ser executados após `npm ci` em um ambiente com acesso ao npm:

```bash
npm ci
npm test
npm run typecheck
npm run agent:build
npm run host:build
npm run ext:build
```

Estas correções foram aplicadas ao código-fonte local do ZIP. Não foi criado commit nem enviado push ao GitHub nesta etapa.
