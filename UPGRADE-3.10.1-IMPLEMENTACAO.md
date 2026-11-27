# LordMarketplacesAnalytics 3.10.1 — implementação incremental

**Data:** 26/11/2026  
**Base:** `LordMarketplacesAnalytics-3.10.0-upgraded.zip`  
**Objetivo:** corrigir pontos descobertos na auditoria, implementar o que podia ser validado localmente e refazer o debug.

## Etapas concluídas

### 1. Linha de base e inventário de lacunas

A matriz contém 365 requisitos individuais. A revisão anterior contabilizava 174 implementados, 161 parciais/não comprovados e 30 ausentes. Os itens foram separados por capacidade local, necessidade de sessão real de marketplace e dependência de credenciais/API externa.

### 2. Navegação guiada de áreas autorizadas

- Novo botão `Varredura de áreas autorizadas` no painel lateral da extensão.
- O início exige confirmação explícita do usuário.
- Os content scripts de Mercado Livre, Shopee e Amazon retornam somente links de navegação visíveis que apontem para áreas de vendedor reconhecidas.
- O worker valida HTTPS, mesma origem, mesmo marketplace e allowlist de tipos de página.
- A navegação ocorre em aba temporária, com deduplicação, limite máximo de 12 páginas e parada em login/CAPTCHA/verificação.
- Não lê cookies/tokens de marketplace, não chama endpoints privados e não clica em ações de alteração.
- Requisitos #14 e #51 reclassificados como parciais, pois não é uma varredura integral de todas as telas/períodos/contas.

### 3. Desconexão segura de conectores

- Novo método IPC `connector.disconnect` e sua declaração em `contracts.json`.
- Revoga somente segredos com prefixo `connector:<id>:`; não toca nas credenciais de outro conector.
- Apaga metadados de credenciais, desabilita o conector e define `NAO_CONECTADO` dentro de uma transação.
- Registra auditoria com contagens, sem gravar tokens ou valores secretos.
- A ação está disponível na interface para permitir a limpeza mesmo quando o catálogo parece inativo.
- Requisito #304 reclassificado como parcial: falta fluxo real OAuth/API e validação com um provedor conectado.

### 4. Gerador de schema SQLite

Criado `scripts/db-generate.mjs`, antes referenciado pelo `package.json` mas ausente. Ele executa as migrations em SQLite em memória, valida versões únicas, integridade e chaves estrangeiras, e gera `dist/database/schema.sql`. A opção `--check` apenas valida e não grava arquivo.

### 5. Auditoria estática do workspace

Criado `scripts/audit-project.mjs` e o comando `npm run audit`. O verificador confere versões, referências de scripts, arquivos do manifest, ações de UI, handlers IPC, permissões, contratos, arquivos JSON e filtros de navegação simulados nos três content scripts.

### 6. Versionamento e documentação

Versão atualizada para `3.10.1` em pacote, lockfile, manifest, painel, serviço e instalador; o novo verificador também detecta divergência de versão no instalador. Checklist de 365 requisitos e resumo JSON atualizados. Foram adicionados testes Vitest para a desconexão/limpeza de segredos e para a navegação autorizada.

## Debug executado nesta rodada

| Verificação | Resultado |
|---|---|
| Auditoria do workspace | **334/334 aprovadas** |
| JavaScript/MJS/CJS | **18 arquivos**, `node --check`, sem erros |
| TypeScript/TSX | **51 arquivos**, parser sintático sem erros (não é typecheck semântico) |
| Build da extensão MV3 | **Aprovado**, pacote gerado em `dist/extension` |
| SQLite | **9 migrations**, 131 objetos, `integrity_check=ok`, zero violações FK |
| Links de navegação | Simulação isolada dos três content scripts: só links visíveis, same-origin e áreas conhecidas passaram |
| Desconexão SQLite | Smoke test com as classes reais `LocalDatabase`/`SecretStore` transpileadas: 2 segredos removidos, outro conector preservado, metadados apagados, estado desativado |
| Vitest | **Bloqueado**: pacote não está instalado/disponível |
| `tsc --noEmit` | **Bloqueado**: dependências e tipos ausentes |
| Build do agente e do host | **Bloqueados**: `esbuild` ausente/incompleto |
| Chrome/Edge e contas reais | **Não executados**: sem sessão autenticada de vendedor neste ambiente |
| APIs/OAuth e integrações externas | **Não executadas**: sem credenciais/fluxos de provedor |

O `npm ci --no-audit --no-fund` não conseguiu completar devido à indisponibilidade de rede deste ambiente. Por isso, os testes Vitest escritos nesta rodada não são apresentados como executados.

## Estado da matriz após a rodada

| Estado | Quantidade |
|---|---:|
| Implementados no código | 174 |
| Parciais ou não comprovados | 164 |
| Não implementados ou não funcionais | 27 |
| **Total** | **365** |

Os 27 requisitos ainda ausentes são: **46, 47, 52, 53, 80, 128, 130, 132, 178, 179, 195, 246, 247, 248, 256, 258, 284, 287, 289, 292, 293, 294, 295, 296, 297, 298 e 299**.

Esses itens incluem leitura estruturada de reclamações e motivos de devolução, sincronização multiloja/multimarketplace, lucro realizado com dados transacionais completos, comparação automática de frete/imagens/anúncios patrocinados, alteração de campanhas, criação/publicação de variações/ofertas, modos autônomos, agendamento/relatórios e integrações PDF/API/OAuth. Não foram simulados como concluídos: dependem de dados ou sessões reais, desenho de permissões e/ou credenciais de provedores externos.

## Próximo ciclo necessário para fechar os itens externos

Para validar coleta e sincronização faltam contas autenticadas de Mercado Livre, Shopee e Amazon com páginas representativas; para conectores faltam chaves e configuração OAuth dos provedores escolhidos. A automação de publicação/campanhas deve permanecer submetida a aprovação explícita, registro de auditoria e possibilidade de rollback, não ser ligada como ação irrestrita.
