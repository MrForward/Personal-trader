// Values that must never reach logs, errors, exports or snapshots.
const registered = new Set();
const ENV_SECRETS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'KITE_API_SECRET'];

export function registerSecret(value) { if (typeof value === 'string' && value) registered.add(value); }

export function redact(message) {
  let text = String(message ?? '');
  for (const secret of [...registered, ...ENV_SECRETS.map(name => process.env[name])]) if (secret) text = text.split(secret).join('[redacted]');
  return text;
}
