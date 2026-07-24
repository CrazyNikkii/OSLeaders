export function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];

  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} must be set.`);
  }

  return value;
}

export function requiredConfiguredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = requiredEnvironmentValue(environment, name);

  if (value.includes('REPLACE_WITH_')) {
    throw new Error(`${name} must not use the example placeholder.`);
  }

  return value;
}
