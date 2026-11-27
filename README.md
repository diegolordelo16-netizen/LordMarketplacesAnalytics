# Marketplace Intelligence & Autonomous Operations — 3.19.0 candidata

Plataforma Local First para inteligência e operação de marketplaces. A versão oficial permanece 3.16.0 até integração e validação da cadeia de candidatas. A candidata 3.19.0 deriva da 3.18.0 (PR 13). Não representa uma release estável aprovada.

## Instalação e operação

- Windows: utilize o instalador gerado pelo workflow CI da versão correspondente. O runtime Node e o serviço local são incluídos. A extensão MV3 deve ser carregada no Chrome ou Edge; o instalador registra o Native Messaging Host. A inicialização automática é opcional e desmarcada por padrão.
- Selecione a conta autorizada no painel. Capturas dependem de abas compatíveis e sessões autenticadas; contas sem correspondência não são confundidas com outras.
- APIs oficiais e DataForSEO exigem configuração e credenciais legítimas. Cotas e custos desconhecidos não são tratados como zero.
- Antes de atualizar, preserve backup. O atualizador usa manifesto de arquivos com digest SHA-256 confirmado, validação do payload, backup, health check e rollback. Atualizações de runtime/instalador usam o instalador completo.

## Evolução e evidências

- [Etapa 03 — extensão e coleta](docs/ETAPA-03-PENDENCIAS.md)
- [Etapa 04 — dashboard](docs/ETAPA-04-AUDITORIA.md)
- [Etapa 05 — financeiro, Ads, estoque e anúncios](docs/ETAPA-05-AUDITORIA.md)
- [Etapa 06 — SEO, concorrência e pós-venda](docs/ETAPA-06-AUDITORIA.md)
- [Etapa 07 — agentes, automações e atualização](docs/ETAPA-07-AUDITORIA.md)
- [Etapa 08 — conectores e importações](docs/ETAPA-08-AUDITORIA.md)
- [Etapa 09 — relatórios e administração](docs/ETAPA-09-AUDITORIA.md)
- [Etapa 10 — auditoria e critérios de release](docs/ETAPA-10-AUDITORIA.md)
- [Matriz de rastreabilidade dos 365 requisitos da candidata](docs/MATRIZ-FINAL-365-REQUISITOS.md): revisão, fontes e lacunas explícitas.
- [Matriz histórica dos 365 requisitos](docs/AUDITORIA-RECURSIVA-365-REQUISITOS.md): classificações históricas não são homologação da candidata atual.

## Desenvolvimento

Requer Node.js 22.13.0 ou superior.

```bash
npm ci
npm audit --audit-level=low
npm run typecheck
npm run agent:build
npm run host:build
npm run ext:build
npm test
node --test scripts/regression-3109.test.mjs
npm run audit
npm run smoke:local
npm run audit:publish
npm run db:generate -- --check
node --test installer/scripts/update-manager.test.mjs
```

Em Windows com Inno Setup 6: `npm run package:win`. A CI executa também smoke do serviço compilado, atualização e rollback em diretórios temporários. Isso não equivale à execução do instalador completo em máquina limpa nem à homologação de Chrome/Edge com vendedores reais.

## Regras de integridade

Ausente não é zero; estimativas não são dados reais. Ações sensíveis exigem autorização, isolamento e evidência posterior; sem prova, não declarar publicação ou reversão efetiva. Consulte as limitações de cada etapa antes de habilitar mutações externas. A aprovação automatizada é requisito necessário, não suficiente para declarar todos os 365 requisitos homologados.
