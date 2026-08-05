import { loadRuntimeConfiguration } from '../src/infrastructure/config/runtime-environment.js';
import { registerDiscordCommands } from '../src/infrastructure/discord/development-command-registration.js';

async function main(): Promise<void> {
  await registerDiscordCommands(loadRuntimeConfiguration());
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Discord command registration failed.';
  console.error(message);
  process.exitCode = 1;
});
