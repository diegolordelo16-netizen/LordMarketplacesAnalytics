# Upgrade 3.2.1 — hardening e confiabilidade

Esta atualização parte do código enviado no ZIP (branch `master`, commit `c6de5f317e47f559b67b236ff9b77786dfd3369a`). O foco foi corrigir falhas de segurança e robustez identificadas na auditoria, sem ampliar permissões do navegador além do loopback necessário para a API local.

## Alterações

### Segurança da extensão e IPC
- O service worker só aceita chamadas `MI_CALL` originadas de páginas da própria extensão. Content scripts e páginas de marketplace não conseguem consultar o token de sessão armazenado nem acionar métodos privilegiados por essa ponte.
- A permissão de host para `http://127.0.0.1/*` foi adicionada para o acesso da extensão ao serviço local. Não foi usada a permissão ampla `<all_urls>`.
- A versão exibida pelo painel e a versão do manifest foram alinhadas em `3.2.1`.

### Native Messaging e compatibilidade
- O host agora recompõe frames mesmo quando o cabeçalho ou o payload chegam divididos entre vários chunks de stdin.
- Mensagens são processadas e respondidas sequencialmente, preservando a ordem e evitando respostas concorrentes fora de ordem.
- EOF com frame incompleto é reportado; frames acima do tamanho permitido continuam rejeitados.
- Versões de protocolo incompatíveis são rejeitadas no host e novamente no dispatcher do serviço, antes de executar o método.

### Auto-upgrade controlado
- Caminhos absolutos, traversal (`..`), caminhos de unidade Windows e caminhos que atravessam symlinks para fora da raiz são recusados.
- Os caminhos de origem e destino do diff são validados antes de ler/gravar.
- Todos os hunks de todos os arquivos são pré-validados antes da primeira gravação.
- Se uma gravação falhar, o motor tenta restaurar os conteúdos originais dos arquivos já tocados e reporta qualquer falha de rollback.

### Banco, captura e métricas
- Migrations aplicadas são verificadas por checksum; também é detectada a ausência de um arquivo de migration já aplicado.
- A validação de todas as migrations acontece antes de executar migrations pendentes, evitando alterações parciais quando há drift.
- Rollback de transações aninhadas libera o savepoint depois de `ROLLBACK TO`.
- Capturas são recusadas quando a conta inexiste, está inativa ou pertence a outro marketplace.
- A lista de inputs ausentes dos KPIs respeita o fallback de GMV usado pelo cálculo de faturamento bruto.
- Funções estatísticas validam probabilidades, contagens, amostras, níveis de confiança, alpha/poder e parâmetros do prior Beta.

### Integração contínua
- Foi adicionado workflow do GitHub Actions para instalar dependências, executar typecheck e testes e construir local-agent, native-host e extensão em pushes/PRs para `master`.

## Validação realizada neste ambiente

- Parser TypeScript: 49 arquivos sem erros de sintaxe.
- Sintaxe JavaScript dos service/content scripts: aprovada.
- JSON de `package.json`, `package-lock.json` e `manifest.json`: válido.
- Testes isolados executados: frames fragmentados/ordem do Native Messaging, bloqueio de traversal e symlink, pré-validação atômica de patches e domínios de entrada estatísticos: aprovados.
- Teste real com `node:sqlite`: migrations do repositório aplicadas e reaplicadas idempotentemente; drift/remoção de migration detectados; savepoint aninhado liberado após rollback: aprovado.
- `git diff --check` com tratamento de CRLF: aprovado.

**Limitação:** a instalação completa de dependências (`npm ci`) não terminou porque o ambiente não conseguiu resolver o registro do npm (`EAI_AGAIN`). Por isso, a suíte completa Vitest, o typecheck oficial e os três builds ainda precisam ser executados em ambiente com acesso ao npm. O workflow de CI adicionado fará essa validação quando o projeto for enviado ao GitHub.
