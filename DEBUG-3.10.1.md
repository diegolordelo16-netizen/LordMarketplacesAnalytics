# DEBUG — LordMarketplacesAnalytics 3.10.1

Data: 26/11/2026

## Resultado

- `node scripts/audit-project.mjs`: 335/335 verificações aprovadas (inclui versão do instalador).
- `node scripts/build-extension.mjs`: aprovado; 8 referências do manifest resolvidas.
- `node scripts/db-generate.mjs --check`: 9 migrations, 131 objetos, integridade SQLite aprovada, zero violações de chave estrangeira.
- `node --check`: 18 arquivos JS/MJS/CJS sem erros.
- Parser TypeScript: 51 fontes TS/TSX sem erros sintáticos.
- Simulação VM de navegação: Mercado Livre, Shopee e Amazon retornaram somente links visíveis e reconhecidos na mesma origem.
- Smoke test com SQLite real e `SecretStore`: removeu tokens/refresh token de um conector, preservou o segredo de outro, apagou metadados e marcou o conector como desativado/`NAO_CONECTADO`.

## Bloqueios de validação

- `npm ci` não concluiu porque a rede de pacotes ficou indisponível; `node_modules` permaneceu incompleto.
- Vitest não disponível; testes automatizados foram adicionados, mas não executados.
- `tsc --noEmit` semântico bloqueado por tipos/dependências ausentes.
- Builds do agente e native host bloqueados por ausência de `esbuild`.
- Sem navegador real ou sessões logadas; Chrome/Edge, marketplace e OAuth não homologados.

## Regressões cobertas por código/testes adicionados

- Desconectar conector limpa somente o namespace do próprio conector, preserva o segredo de outro conector e não registra token na auditoria.
- Navegação guiada só aceita HTTPS, mesmo origin/marketplace, área de vendedor reconhecida, links visíveis e limite de 12 páginas; interrompe em login/CAPTCHA.
- `npm run audit` verifica as referências de build, manifest, versões, UI, IPC, permissões e JSON.
