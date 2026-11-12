// Minimal environment loading. Values come from the process
// environment, optionally supplemented by a local .env file next to
// the project root (.env) for the operator's own machine. The
// .env file is never committed (see .gitignore) and its values are
// never printed, logged, or returned by any route in this project.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv(): void {
  const envPath = join(projectRoot, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export interface PayPalConfig {
  clientId: string | null;
  clientSecret: string | null;
  env: string;
  webhookId: string | null;
}

export function paypalConfig(): PayPalConfig {
  return {
    clientId: process.env.PAYPAL_CLIENT_ID || null,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || null,
    env: (process.env.PAYPAL_ENV || "sandbox").toLowerCase(),
    webhookId: process.env.PAYPAL_WEBHOOK_ID || null,
  };
}

export function paypalConfigured(): boolean {
  const cfg = paypalConfig();
  return Boolean(cfg.clientId && cfg.clientSecret);
}
