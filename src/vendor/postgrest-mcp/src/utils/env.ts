// Platform-agnostic environment variable access
// Works with both Node.js (process.env) and Deno (Deno.env)
export const getEnv = (key: string): string | undefined => {
  // @ts-ignore - process may not exist in Deno
  if (typeof globalThis.process !== "undefined" && globalThis.process.env) return globalThis.process.env[key];
  // @ts-ignore - Deno may not exist in Node
  if (typeof globalThis.Deno !== "undefined" && globalThis.Deno.env) return globalThis.Deno.env.get(key);
  return undefined;
};

export const setEnv = (key: string, value: string): void => {
  // @ts-ignore - process may not exist in Deno
  if (typeof globalThis.process !== "undefined" && globalThis.process.env) globalThis.process.env[key] = value;
  // @ts-ignore - Deno may not exist in Node
  if (typeof globalThis.Deno !== "undefined" && globalThis.Deno.env) globalThis.Deno.env.set(key, value);
};
