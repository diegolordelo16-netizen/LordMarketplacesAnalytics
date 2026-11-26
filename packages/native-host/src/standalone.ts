/**
 * Executável do host nativo: inicia o serviço local em processo único e fala o
 * protocolo de mensagens nativas em stdin/stdout.
 *
 * Variáveis:
 *   MI_DATA_DIR    diretório de dados (default %LOCALAPPDATA%\MarketplaceIntelligence)
 *   MI_EXTENSION_ID  ID da extensão autorizada (origem validada pelo Chrome)
 */
import { bootstrap, runNativeHost } from '@mi/local-agent';

const dataDir = process.env.MI_DATA_DIR;
const app = bootstrap(dataDir ? { dataDir } : {});
runNativeHost(app);
