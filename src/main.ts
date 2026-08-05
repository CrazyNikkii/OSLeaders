import { loadRuntimeConfiguration } from './infrastructure/config/runtime-environment.js';
import { startDiscordRuntime } from './infrastructure/discord/development-runtime.js';

async function main(): Promise<void> {
  const runtime = await startDiscordRuntime(loadRuntimeConfiguration());
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void runtime.close().catch(() => {
      process.exitCode = 1;
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'OSLeaders startup failed.';
  console.error(message);
  process.exitCode = 1;
});
