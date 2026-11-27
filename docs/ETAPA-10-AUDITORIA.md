# Etapa 10 — candidata 3.19.0

Base: 820adcd6165d90efa38a1679a8f313a72cf1bae3 (3.18.0, PR 13). CI 279 aprovada nos jobs Linux e Windows. Evidência da base: https://github.com/diegolordelo16-netizen/LordMarketplacesAnalytics/actions/runs/46070035141. Não reutilizar essa aprovação como aprovação do novo commit.

## Correções desta rodada
- Versão de pacote, lock, extensão, painel, serviço e instalador alinhada.
- Inicialização Windows opt-in e limpeza da entrada antiga de registro ao desmarcar em upgrade.
- Dashboard: ausência de cobertura de estoque sem unidade enganosa; erros do resumo de lucro explícitos; explicação de fórmulas e limites de conciliação.
- Auditoria estática verifica as correções anteriores.
- README atualizado com documentação, instruções e limites.

## Requisitos 326–365: revisão inicial, não homologação
| IDs | Evidência disponível ou bloqueio |
|---|---|
| 326, 328, 333–337, 339–342, 344 | Recursos de interface existentes; revalidar com suíte da candidata. |
| 327, 343 | Auditoria estática de ações/handlers é necessária, mas não prova cada fluxo ponta a ponta; revisão completa pendente. |
| 329–332 | Filtros do dashboard por marketplace, conta, recência de snapshot, anúncio e SKU; cobertura transversal não comprovada. |
| 338 | Explicações do dashboard ampliadas; revisar demais telas e fórmulas. |
| 345, 347–348, 352–356 | SQLite, host, segredos e guardas existentes; reexecutar testes e auditoria na candidata. |
| 346, 349–351 | Persistência, proteção, isolamento e trilha existentes; não presumir prova exaustiva. |
| 357–358, 361 | Compilação EXE aprovada na base; execução do instalador/desinstalação em Windows limpo não comprovada. |
| 359 | Opt-in explícito implementado; CI e instalação real ainda necessárias. |
| 360 | Atualização e rollback aprovados na base com versão anterior sintética; repetir na candidata e distinguir upgrade histórico real. |
| 362 | CI da base aprovada; CI do novo SHA pendente. |
| 363–364 | Simulações e verificações locais não são homologação com navegadores e contas reais. |
| 365 | README e auditoria atualizados; matriz histórica permanece histórica, requer consolidação final. |

## Portão de release
1. CI verde no SHA candidato, incluindo dependências, typecheck, builds, regressões, auditoria, smoke, integridade de banco, atualizador e EXE.
2. Revisão das limitações técnicas anteriores (mutações e reversões sem executor seguro, cobertura de coleta, conectores externos). Não confundir implementação parcial com homologação dispensada.
3. Consolidar a matriz com evidências verificáveis por requisito; registrar testes reais dispensados como não executados, sem simular resultado.
4. Integrar PRs empilhados em ordem, conferindo o SHA e CI da master, sem force push.
5. Somente depois de validação e autorização de publicação, promover release estável.

## Revisão adicional do inicializador
O launcher anterior concatenava caminhos a uma URL que já continha token, consultava status HTTP sem validar a resposta e copiava arquivos temporários para o diretório de instalação. O serviço também imprimia a URL com token no stdout redirecionado ao log. O novo launcher usa apenas porta validada e loopback, verifica JSON de health/protocolo, monta a rota correta e não copia credenciais ou temporários para a pasta do programa. O serviço grava e imprime URL sem token; o painel usa a recuperação same-origin existente. Foram adicionados quatro testes de regressão. Logs históricos e sessões antigas não são automaticamente apagados nesta correção; devem ser tratados com política de retenção/revogação. A execução do novo launcher no Windows instalado ainda exige validação, além dos testes de suas funções.

## Native Messaging — correção de empacotamento
O manifesto anterior atribuía a `path` uma linha de comando Node + argumento JS, não um caminho de arquivo. O build agora gera um wrapper Windows `native-host.bat`, que usa o runtime embarcado e encaminha os argumentos da extensão. O instalador inclui o wrapper e o registro valida ID, arquivos e caminho absoluto antes de gravar o manifesto. Referência: https://github.com/GoogleChrome/chrome-extensions-samples/blob/main/api-samples/nativeMessaging/host/com.google.chrome.example.echo-win.json. Foi adicionada uma regressão estática. A mudança do registro/launcher requer reinstalação com o instalador completo; atualização de payload isolada não reconfigura o registro de versões antigas. O funcionamento em Chrome/Edge reais ainda não foi comprovado.

## Validação adicional planejada na CI
Acrescentado smoke de instalação e desinstalação do EXE em runner Windows descartável: registro Chrome/Edge, manifesto real, frame do host pelo wrapper, inicialização sem autorun obrigatório, health, remoção do runtime/registro e preservação do banco. O teste não executa os navegadores reais; precisa passar no SHA final e não substitui homologação real. Não executar em máquina de produção.

## Debug da CI 280
Run 46070910239 (PR, head 4481a16): job Linux aprovado integralmente; Windows aprovou build, atualizador, geração do instalador e todas as asserções funcionais do novo smoke, inclusive desinstalação e preservação dos dados. O job falhou depois do OK funcional, em finally, por EBUSY ao remover uninstall.log ainda aberto pelo desinstalador. Correção: não invocar o desinstalador duas vezes após sucesso e permitir retentativas limitadas de limpeza de arquivos temporários; nenhuma asserção funcional removida. Revalidar o novo SHA. Evidência: https://github.com/diegolordelo16-netizen/LordMarketplacesAnalytics/actions/runs/46070910239/job/140747436925.

## Revisão de UX e isolamento de apresentação
Ordenação pt-BR numérica de moeda, percentual, datas e valores simples; ausentes ficam no fim em ambas as direções. Troca de conta limpa IDs de anúncio/SKU e filtros antigos, estado de importação e paginação de relatório, preservando o intervalo escolhido. Respostas atrasadas de KPI por anúncio e drilldown são descartadas quando o escopo ou a tela mudou; drilldown usa os mesmos dias UTC completos da comparação executiva. Três regressões direcionadas acrescentadas. Filtros por conta, período, marketplace e SKU continuam específicos das telas que suportam cada dimensão; não aplicar um filtro de vendas a dados sem janela comercial comprovada.

## Fluxo de alertas
A CI 290 aprovou integralmente o SHA 6a08cccaceb7d2c0f7dd4e60f025f75347ed131e: Linux e Windows, 44 regressões, 712 checks, EXE instalado e removido, dados preservados, 0 vulnerabilidades npm. Artefatos: https://github.com/diegolordelo16-netizen/LordMarketplacesAnalytics/actions/runs/46071305739. Revisão seguinte: alertas filtrados por loja com globais identificados, título/recomendação exibidos, reconhecimento e falso positivo com confirmação explícita e permissão administrativa. Serviço rejeita IDs ausentes/escopo divergente, guarda transação e auditoria, evita duplicidade e classificação conflitante. Corrigido também filtro ignorado de competitor.alerts. Teste de isolamento, autorização e idempotência acrescentado; CI do novo SHA necessária. Não transforma alerta reconhecido em ação comercial executada.

## Consolidação e cobertura de interface
Foi acrescentada [matriz rastreável de 365 IDs](MATRIZ-FINAL-365-REQUISITOS.md), preservando classificação histórica e distinguiendo evidência de etapa, limites e revalidação individual ainda pendente. A varredura do código encontrou 225 métodos IPC registrados, 209 com referência literal nos clientes app.js, prestart.js, painel da extensão e worker; 16 sem referência literal. Não confundir chamada literal com teste de funcionamento. 

Sem chamada literal direta: auth.logout (usado na rotação do servidor), settings.set (genérico; UI usa métodos específicos), guard.evaluate (simulação/guard interno), keyword.googleVolume (fluxo externo posterior via seo.external.volume), competitor.upsert/list/timeline/alerts (legado sem tela direta), competitor.monitoring.record e competitor.evidence.record (ingestão/evidência; conteúdo e histórico têm fluxos específicos), task.verifySaved e task.rollbackPlan (verificação/plano; não expor como comprovação manual de publicação), agent.run (simulação), agent.debate (workspace externo tem fluxo próprio), autoupgrade.apply e autoupgrade.rollback (deliberadamente bloqueados no IPC). A revisão não transforma métodos de baixo nível em botões de execução; os fluxos de produto e UI ainda precisam de auditoria integral onde faltam evidências.
