# Etapa 08 — APIs, conectores e importações — 3.17.0 candidata

Base: master 3.16.0, merge e315a665, CI 238 aprovada. Versão candidata, ainda não publicada.

## Escopo
Requisitos 290–304 da matriz de 365: CSV, XLSX, PDF, APIs oficiais opcionais, serviços externos, Trends, GA4, Search Console, SEO, inteligência de marketplace, teste, ativação/desativação, custos/limites, última sincronização e desconexão. Requisito 305 (operação offline) deve permanecer funcional. Relatórios/administração serão conferidos na etapa seguinte; o plano histórico também agrupa os nove itens parciais 306–311, 315, 321, 325, sem declará-los concluídos aqui.

## Primeira auditoria
- CSV/XLSX: staging e mapeamento já existentes. Corrigida colisão entre nomes duplicados e nomes com sufixos já presentes, que podia sobrescrever dados. XLSX recusa entradas ZIP duplicadas e dados além do cabeçalho. Adicionados testes de regressão CSV; ampliar fixtures XLSX.
- PDF: extração digital com revisão manual; OCR e cobertura de layouts devem ser auditados.
- Google GA4 e Search Console: configuração/teste de propriedade por token de acesso existentes; renovação OAuth, sincronização incremental, limites e tratamento de revogação precisam de implementação e testes.
- OpenSEO/DataForSEO: integração existente deve manter escopo, rastreabilidade e controle de chamadas pagas. Não alterar comportamento local sem credenciais.
- Outros serviços e Trends: catálogo não equivale a integração ativa. Verificar interfaces e dependências oficiais antes de implementar.
- Status, custos, última sincronização e desconexão: auditar por provedor e garantir que estados sejam baseados em evidência.
- Homologação de conta real e APIs pagas dispensada nesta fase; testes automatizados não dispensados.

## Validação
Versão alinhada em package, lock, serviço, extensão, painel e instalador. CI da candidata precisa concluir; não declarar etapa encerrada.


## Segunda auditoria — implementação e validação
- Requisitos 290/291: CSV/XLSX com colunas únicas, proteção ZIP, staging, mapeamento, retomada da prévia paginada e rejeição de datas futuras ou valores negativos.
- 292: PDF digital e OCR local opcional (Poppler + Tesseract com por/eng no PATH, até 8 páginas, 2 MB). Texto permanece em revisão; promoção direta de PDF bloqueada. OCR depende das ferramentas instaladas, não está embutido no instalador.
- 293: adapters oficiais de leitura e autenticação para Mercado Livre, Shopee e Amazon SP-API, com identidade e região, listagem paginada, continuação vinculada ao escopo e sem replay bem-sucedido. Não fazem mutações nem afirmam cobertura de todos os endpoints. ML offset até 950; Shopee itens NORMAL; Amazon marketplace BR.
- 294/298/299: OpenSEO/DataForSEO preservados; exportações CSV/XLSX de outros serviços autorizados ficam segregadas com fornecedor, dataset, data e origem declarados. Não existe API genérica sem documentação/contrato específico.
- 295: Trends via exportação oficial importada manualmente, índices relativos, <1 distinto de zero. API alfa condicionada à autorização Google; sem acesso ao contrato alfa não se inventa integração.
- 296/297: GA4 e Search Console por token de acesso ou renovação com refresh token e credenciais do aplicativo, janela diária de até 90 dias e avanço incremental com sobreposição. Sem somar dados web a KPIs de marketplace. Obtenção inicial do consentimento/token no console oficial; uma configuração por provedor vinculada a uma loja, troca explicitamente confirmada.
- 300/301/303/304: teste oficial, habilitação após teste, estado de revogação, último sucesso, histórico e remoção dos segredos cifrados; sem revogar autorização no provedor por chamada externa automática.
- 302: cotas locais 30 chamadas/24h por provedor e 5 por operação, DataForSEO 20 consultas/24h e bloqueio de novas consultas ao atingir USD 5 conhecidos. Custos não informados são desconhecidos; não é teto garantido da fatura.
- 305: operação local sem API preservada, testes de credenciais ausentes e smoke offline.
- CI 242 aprovou a revisão inicial; CI 254 revelou aspas SQL inválidas, corrigidas. CI 258 revelou diferença de mensagem no bloqueio de credencial, corrigida. Novos testes cobrem renovação, quota, isolamento, paginação, Trends, importações e contratos dos providers com fixtures. Homologação com contas reais/API paga dispensada. CI final deve validar o SHA atual, não execução anterior.

Fontes técnicas públicas: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport ; https://developers.google.com/webmaster-tools/v1/searchanalytics/query ; https://developers.mercadolivre.com.br/en_us/items-and-searches ; https://open.shopee.com/ ; https://developer-docs.amazon.com/sp-api/lang-en_EN/reference/searchlistingsitems ; https://developers.google.com/search/apis/trends .
