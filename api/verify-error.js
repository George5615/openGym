// @simplewebauthn reports an RP_ID or origin mismatch as an opaque "Unexpected ..." string, and
// whoever reads it in the browser has no way to connect that to their .env. A misconfigured
// RP_ID/ORIGIN is the single most common self-hosting failure (see docs/SELF_HOSTING.md), so
// name both values back. Neither is a secret: one is the address bar, the other its hostname.
const MISCONFIGURED = /unexpected (rp id|authentication response origin|registration response origin)/i;

export function verifyError(e, { rpId, origin, origins } = {}) {
  const msg = String((e && e.message) || 'verification failed');
  if (!MISCONFIGURED.test(msg)) return 'verification failed: ' + msg;
  const accepted = Array.isArray(origins) && origins.length ? origins : [origin].filter(Boolean);
  const originConfig = accepted.length > 1
    ? `allowed origins=${accepted.join(',')}`
    : `ORIGIN=${accepted[0] || origin}`;
  return `${msg} — this server is configured with RP_ID=${rpId} and ${originConfig}. `
    + 'The address you opened must be one of those origins and valid for that RP ID. See docs/SELF_HOSTING.md.';
}
