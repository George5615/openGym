import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2]
if (!['non-pwa', 'pwa'].includes(mode)) {
  console.error('usage: node scripts/verify-pwa-build.mjs <non-pwa|pwa>')
  process.exit(2)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
const manifest = path.join(dist, 'manifest.json')
const swPath = path.join(dist, 'sw.js')

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) return jsFiles(p)
    return entry.isFile() && entry.name.endsWith('.js') ? [p] : []
  })
}
const js = jsFiles(dist).map(p => fs.readFileSync(p, 'utf8')).join('\n')

function check(ok, message) {
  if (!ok) {
    console.error('PWA build check failed:', message)
    process.exitCode = 1
  }
}

const hasManifestMarkup = /rel=["']manifest["']/.test(html)
const hasMobileMeta = /(?:apple-)?mobile-web-app-capable/.test(html)
const hasAppleIcon = /rel=["']apple-touch-icon["']/.test(html)
const registersSw = /serviceWorker\.register\(/.test(js)

if (mode === 'non-pwa') {
  check(!hasManifestMarkup, 'non-PWA index contains a manifest link')
  check(!hasMobileMeta, 'non-PWA index contains mobile web app meta')
  check(!hasAppleIcon, 'non-PWA index contains apple-touch-icon markup')
  check(!fs.existsSync(manifest), 'non-PWA dist contains manifest.json')
  check(!fs.existsSync(swPath), 'non-PWA dist contains sw.js')
  check(!registersSw, 'non-PWA JavaScript still registers a service worker')
} else {
  check(hasManifestMarkup, 'PWA index has no manifest link')
  check(hasMobileMeta, 'PWA index has no mobile web app meta')
  check(hasAppleIcon, 'PWA index has no apple-touch-icon markup')
  check(fs.existsSync(manifest), 'PWA dist has no manifest.json')
  check(fs.existsSync(swPath), 'PWA dist has no sw.js')
  check(registersSw, 'PWA JavaScript does not register the service worker')
  if (fs.existsSync(swPath)) {
    check(!fs.readFileSync(swPath, 'utf8').includes('__BUILD__'), 'PWA sw.js was not stamped')
  }
}

if (!process.exitCode) console.log(`${mode} build verified`)
