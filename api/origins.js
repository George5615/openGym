// One API may sit behind more than one browser-facing web origin. ORIGIN remains the canonical
// origin for cookies/VAPID and old single-host installs; ALLOWED_ORIGINS only widens browser
// origins that may complete WebAuthn and the CSRF fallback used when Sec-Fetch-Site is absent.
export function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

export function allowedOrigins(origin, extra = '') {
  const out = []
  for (const value of [origin, ...String(extra || '').split(',')]) {
    const normalized = normalizeOrigin(value)
    if (normalized && !out.includes(normalized)) out.push(normalized)
  }
  return out
}

export function originAllowed(origin, allowed) {
  const normalized = normalizeOrigin(origin)
  return !!normalized && allowed.includes(normalized)
}
