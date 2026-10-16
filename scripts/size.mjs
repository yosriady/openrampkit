#!/usr/bin/env node
// `pnpm size`: bundle each browser entry point the way an app bundler would, then check
// the minified and gzipped size against scripts/size-budget.json.
//
// Each entry is the built ESM file in dist/, so run `pnpm build` first. The bundle includes
// all dependencies (workspace packages, lit, and so on). Only the peer dependencies of the
// package (react, vue, viem, ...) stay external, because the app already ships them.
// Read "Bundle size" in CONTRIBUTING.md before you raise a budget.
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const budgets = JSON.parse(readFileSync(join(root, 'scripts/size-budget.json'), 'utf8')).entries

const kb = (bytes) => `${(bytes / 1000).toFixed(2)} kB`

async function measure({ package: dir, entry }) {
  const pkgDir = join(root, dir)
  const file = join(pkgDir, entry)
  if (!existsSync(file)) throw new Error(`${dir}/${entry} is missing. Run \`pnpm build\` first.`)
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const peers = Object.keys(pkg.peerDependencies ?? {})
  const result = await build({
    entryPoints: [file],
    absWorkingDir: pkgDir,
    bundle: true,
    minify: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    // A peer and its subpaths (for example `react/jsx-runtime`) stay external.
    external: peers.flatMap((p) => [p, `${p}/*`]),
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
  })
  const code = result.outputFiles[0].contents
  return { min: code.length, gzip: gzipSync(code, { level: 9 }).length }
}

const rows = []
let failed = false
for (const b of budgets) {
  const { min, gzip } = await measure(b)
  const limit = b.limitKb * 1000
  const ok = gzip <= limit
  if (!ok) failed = true
  rows.push({
    entry: b.name,
    'min': kb(min),
    'min+gzip': kb(gzip),
    budget: kb(limit),
    used: `${Math.round((gzip / limit) * 100)}%`,
    status: ok ? 'ok' : 'OVER',
  })
}

const cols = Object.keys(rows[0])
const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)))
const line = (cells) => cells.map((v, i) => String(v).padEnd(width[i])).join('  ')
console.log(line(cols))
console.log(line(width.map((w) => '-'.repeat(w))))
for (const r of rows) console.log(line(cols.map((c) => r[c])))

if (failed) {
  console.error('\nA bundle is over its budget (min+gzip). Find the cause first: a new dependency,')
  console.error('or a server-only import that leaked into a browser package. To raise a budget on')
  console.error('purpose, edit scripts/size-budget.json and say why in the pull request.')
  process.exit(1)
}
