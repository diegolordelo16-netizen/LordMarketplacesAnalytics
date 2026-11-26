# Marketplace Intelligence & Autonomous Operations

Plataforma Local First de inteligência e operações autônomas para marketplaces.
Funciona no navegador autenticado do vendedor: **sem APIs oficiais**, sem cookies,
sem tokens, sem endpoints privados.

## Estado verificado

| Componente | Estado | Prova |
|---|---|---|
| `packages/shared` | TESTADO | 67 testes (KPI, finanças, guard, preservação, similaridade competitiva) |
| `packages/local-agent` | TESTADO | 55 testes (SQLite, captura, guard, Gemini, agentes, concorrentes) |
| `packages/native-host` | TESTADO | 14 testes + smoke real de framing |
| `packages/extension` | PARCIAL | 14 testes estáticos; falta teste em navegador real |
| Instalador Windows | GERADO | `installer/output/MarketplaceIntelligence-Setup.exe` compilado e instalado/desinstalado em teste |

## Instalar (usuário final)

1. Execute `MarketplaceIntelligence-Setup.exe`.
2. Abra **Marketplace Intelligence — Painel local** no menu Iniciar.
3. Abra **Instalar extensão no navegador** e carregue a pasta `extension` em
   `chrome://extensions` (modo do desenvolvedor).

## Desenvolvimento

```bash
npm ci
npx tsc --noEmit -p tsconfig.json     # tipos
npx vitest run                        # suíte completa
node scripts/build-local-agent.mjs    # serviço local
node scripts/build-native-host.mjs    # host nativo + registrador
node scripts/build-extension.mjs      # extensão MV3
node scripts/package-windows.mjs      # instalador (requer Inno Setup 6)
```

## Inteligência competitiva assistida

1. Cadastre o produto próprio (catálogo ou link).
2. Escolha os marketplaces e rode a busca.
3. As sugestões entram em **PENDENTE DE REVISÃO** — nunca aprovadas sozinhas.
4. Aprove, rejeite (com motivo), edite, recategorize ou peça nova análise.
5. Aprovados entram em monitoramento contínuo; rejeitados alimentam o aprendizado.
6. As regras aprendidas (`competitor_learning_rules`) são aplicadas nas próximas buscas,
   com suporte e evidência — não é "modelo treinado", é regra explícita e auditável.

## Regras invioláveis

- Ausente ≠ zero: campo não lido fica `NOT_COLLECTED`/`UNKNOWN`.
- Estimativa nunca é apresentada como dado real.
- Descrição de anúncio só é alterada por acréscimo, com diff auditável.
- Chave Gemini fica cifrada no serviço local, nunca no frontend.
- Ação sensível exige aprovação e entra no `audit_log`.
