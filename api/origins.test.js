import test from 'node:test'
import assert from 'node:assert/strict'
import { allowedOrigins, normalizeOrigin, originAllowed } from './origins.js'

test('ALLOWED_ORIGINS defaults to the canonical ORIGIN', () => {
  assert.deepEqual(allowedOrigins('https://gym.example.com'), ['https://gym.example.com'])
})

test('extra origins are trimmed, normalized and deduplicated', () => {
  assert.deepEqual(
    allowedOrigins(
      'https://igym.example.com/',
      ' https://gym.example.com,https://igym.example.com,, https://gym.example.com/ '
    ),
    ['https://igym.example.com', 'https://gym.example.com']
  )
})

test('originAllowed compares normalized exact origins, never sibling prefixes', () => {
  const allowed = allowedOrigins('https://igym.example.com', 'https://gym.example.com')
  assert.equal(originAllowed('https://igym.example.com/', allowed), true)
  assert.equal(originAllowed('https://gym.example.com', allowed), true)
  assert.equal(originAllowed('https://evil.gym.example.com', allowed), false)
  assert.equal(originAllowed('', allowed), false)
})

test('normalizeOrigin only trims whitespace and trailing slashes', () => {
  assert.equal(normalizeOrigin('  https://gym.example.com/// '), 'https://gym.example.com')
})
