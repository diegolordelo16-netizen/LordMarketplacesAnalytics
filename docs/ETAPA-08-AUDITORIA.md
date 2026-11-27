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
