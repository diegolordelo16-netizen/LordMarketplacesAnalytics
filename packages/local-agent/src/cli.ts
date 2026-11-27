import { main } from './main';

void main().catch((error: unknown) => {
  process.stderr.write(`falha ao iniciar: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
