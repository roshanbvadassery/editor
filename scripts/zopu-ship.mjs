#!/usr/bin/env node
// Ship a fork change to Zopu end to end: publish a pinned release of this fork and move every
// consumer onto it, verified and committed locally. Nothing is ever pushed in a consumer (their
// pushes deploy); this fork's branch is pushed because the release is built from its commit.
//
//   node scripts/zopu-ship.mjs --next              next patch after the latest zopu-* release
//   node scripts/zopu-ship.mjs --tag zopu-1.1.7.0  an explicit tag
//   options:
//     --dry-run          say what would happen, change nothing
//     --no-commit        bump and verify consumers, but leave the changes uncommitted
//     --consumers a,b    consumer folders (default: ../zopu-wide/studio,../zopu-studio-mcp)
//
// Steps: preflight (fork + lingo committed, gh signed in, tag free) → push this fork's branch →
// scripts/zopu-release.mjs --publish → in each consumer: point every release URL at the new tag,
// drop fork links (`npm run fork:link`), npm install, npm ci, build (or import check), commit
// package.json + package-lock.json. Re-running after a failure is safe: an existing release is
// reused, a consumer already on the tag is just re-verified.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'roshanbvadassery/editor'
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const dryRun = flag('dry-run')
const commit = !flag('no-commit')
const consumers = (arg('consumers') ?? '../zopu-wide/studio,../zopu-studio-mcp')
  .split(',')
  .map((c) => path.resolve(root, c.trim()))

const read = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const run = (cmd, args, cwd = root) => {
  console.log(`  $ ${cmd} ${args.join(' ')}${cwd === root ? '' : `   (${path.relative(root, cwd)})`}`)
  if (!dryRun) execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}
const step = (msg) => console.log(`\n▸ ${msg}`)
const fail = (msg) => {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}
const releaseExists = (t) => {
  try {
    read('gh', ['release', 'view', t, '--repo', REPO, '--json', 'tagName'])
    return true
  } catch {
    return false
  }
}

// ── tag ─────────────────────────────────────────────────────────────────────────────────────
let tag = arg('tag')
if (flag('next')) {
  const tags = read('gh', ['release', 'list', '--repo', REPO, '--limit', '100', '--json', 'tagName', '-q', '.[].tagName'])
    .split('\n')
    .filter((t) => /^zopu-\d+(\.\d+)+$/.test(t))
  const nums = (t) => t.slice(5).split('.').map(Number)
  const cmp = (a, b) => {
    const [x, y] = [nums(a), nums(b)]
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
    return 0
  }
  const latest = tags.sort(cmp).at(-1)
  if (!latest) fail('no zopu-* release yet: pass --tag')
  const n = nums(latest)
  n[n.length - 1] += 1
  tag = `zopu-${n.join('.')}`
  console.log(`latest release ${latest} → next ${tag}`)
}
if (!tag || !/^zopu-[\w.-]+$/.test(tag)) {
  fail('usage: node scripts/zopu-ship.mjs (--next | --tag zopu-<version>) [--dry-run] [--no-commit] [--consumers a,b]')
}

// ── preflight ───────────────────────────────────────────────────────────────────────────────
step('Preflight')
const lingo = path.resolve(root, '../lingo')
for (const [dir, label] of [
  [root, 'editor fork'],
  [lingo, 'lingo fork'],
]) {
  if (read('git', ['status', '--porcelain', '--untracked-files=no'], dir)) {
    fail(`The ${label} (${dir}) has uncommitted changes: commit them first (a release is built from commits).`)
  }
}
try {
  read('gh', ['auth', 'status'])
} catch {
  fail('gh is not signed in: run `gh auth login`.')
}
for (const c of consumers) {
  if (!fs.existsSync(path.join(c, 'package.json'))) fail(`No consumer at ${c}`)
  const dirty = read('git', ['status', '--porcelain', '--', 'package.json', 'package-lock.json'], c)
  if (dirty) fail(`${c}: package.json / package-lock.json have uncommitted changes.`)
}
const branch = read('git', ['branch', '--show-current'])
const head = read('git', ['rev-parse', 'HEAD'])
const published = releaseExists(tag)
console.log(`  fork ${branch} @ ${head.slice(0, 8)}; release ${tag} ${published ? 'exists (reused)' : 'is new'}`)
console.log(`  consumers: ${consumers.map((c) => path.relative(root, c)).join(', ')}`)

// ── publish ─────────────────────────────────────────────────────────────────────────────────
if (!published) {
  step(`Push ${branch} and publish ${tag}`)
  run('git', ['push', 'origin', branch])
  run('node', ['scripts/zopu-release.mjs', '--tag', tag, '--publish'])
}

// ── consumers ───────────────────────────────────────────────────────────────────────────────
const RELEASE_URL = /(\/roshanbvadassery\/editor\/releases\/download\/)zopu-[\w.-]+?(\/)/g
for (const c of consumers) {
  const name = path.relative(root, c)
  step(`Move ${name} to ${tag}`)
  const pkgPath = path.join(c, 'package.json')
  const before = fs.readFileSync(pkgPath, 'utf8')
  const after = before.replace(RELEASE_URL, `$1${tag}$2`)
  const count = (before.match(RELEASE_URL) ?? []).length
  if (!count) fail(`${name}: package.json has no ${REPO} release URLs`)
  console.log(`  ${count} release URLs${before === after ? ' (already on the tag)' : ''}`)
  if (!dryRun) fs.writeFileSync(pkgPath, after)

  // A fork link (`npm run fork:link`) leaves symlinks npm would keep: drop them so the tarballs land.
  for (const dir of [path.join(c, 'node_modules/@pascal-app'), path.join(c, 'node_modules')]) {
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir)) {
      const at = path.join(dir, entry)
      if (!fs.lstatSync(at).isSymbolicLink()) continue
      if (dir.endsWith('@pascal-app') || ['three', 'three-bvh-csg'].includes(entry)) {
        console.log(`  unlink fork link ${path.relative(c, at)}`)
        if (!dryRun) fs.rmSync(at, { force: true })
      }
    }
  }

  run('npm', ['install', '--no-audit', '--no-fund'], c)
  run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], c)
  const scripts = JSON.parse(after).scripts ?? {}
  if (scripts.build) run('npm', ['run', 'build'], c)
  else run('node', ['-e', "import('@pascal-app/core').then(()=>console.log('  imports ok'))"], c)

  if (!dryRun) {
    const lock = fs.readFileSync(path.join(c, 'package-lock.json'), 'utf8')
    const stale = [...lock.matchAll(RELEASE_URL)].filter((m) => !m[0].includes(`/${tag}/`)).length
    if (stale) fail(`${name}: package-lock.json still has ${stale} URLs of another release`)
  }
  if (commit) {
    const changed = dryRun || read('git', ['status', '--porcelain', '--', 'package.json', 'package-lock.json'], c)
    if (changed) {
      run('git', ['add', 'package.json', 'package-lock.json'], c)
      run('git', ['commit', '-m', `Pascal fork release ${tag}`], c)
    } else console.log('  nothing to commit')
  }
}

console.log(`\n✓ ${tag}: published and every consumer is on it${commit ? ' (committed locally, not pushed)' : ' (uncommitted)'}.`)
console.log('  Pushing a consumer deploys it: push each when you want it live.')
