#!/usr/bin/env node
// Lists the public workspace packages whose current version is not on npm yet.
// The Release workflow uses the count to decide if it must run the publish job.
// Usage: node scripts/unpublished-packages.mjs
// In GitHub Actions it also writes `count=<n>` to $GITHUB_OUTPUT.
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const registry = (process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/$/, '')

function publicPackages() {
  const out = []
  for (const base of ['packages', 'packages/adapters']) {
    for (const dir of readdirSync(join(root, base))) {
      const file = join(root, base, dir, 'package.json')
      if (!existsSync(file)) continue
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      if (!pkg.private) out.push({ name: pkg.name, version: pkg.version })
    }
  }
  return out
}

async function isPublished({ name, version }) {
  const url = `${registry}/${name.replace('/', '%2f')}`
  const res = await fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } })
  if (res.status === 404) return false
  // Fail closed: an unknown answer must not skip or start a publish.
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const body = await res.json()
  return Boolean(body.versions?.[version])
}

const packages = publicPackages()
const missing = []
for (const pkg of packages) {
  if (!(await isPublished(pkg))) missing.push(pkg)
}

for (const { name, version } of missing) console.log(`not on npm: ${name}@${version}`)
console.log(`${missing.length} of ${packages.length} public packages are not on npm.`)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `count=${missing.length}\n`)
