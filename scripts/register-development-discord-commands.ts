import { loadRuntimeConfiguration } from '../src/infrastructure/config/runtime-environment.js';
import { registerDevelopmentDiscordCommands } from '../src/infrastructure/discord/development-command-registration.js';

async function main(): Promise<void> {
  await registerDevelopmentDiscordCommands(loadRuntimeConfiguration());
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Development command registration failed.';
  console.error(message);
  process.exitCode = 1;
});
