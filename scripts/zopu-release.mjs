#!/usr/bin/env node
// Zopu's pinned build of this fork: every package Zopu runs (Studio, the Studio MCP) is built from
// here and from our lingo fork, packed as a tarball and attached to a GitHub release of
// roshanbvadassery/editor. Nothing comes from Pascal's npm packages: the tarballs' links to each
// other are rewritten to the release's own URLs, and the third-party packages this fork patches
// (three, three-bvh-csg) ship patched beside them.
//
//   node scripts/zopu-release.mjs --tag zopu-1.1.6.1 [--lingo ../lingo] [--publish]
//
// Without --publish it only builds into .zopu-release/<tag>/ (tarballs + manifest.json).
// Consumers depend on the URLs in manifest.json, e.g.
//   "@pascal-app/core": "https://github.com/roshanbvadassery/editor/releases/download/<tag>/core.tgz"
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'roshanbvadassery/editor'
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const tag = arg('tag')
if (!tag || !/^zopu-[\w.-]+$/.test(tag)) {
  console.error('usage: node scripts/zopu-release.mjs --tag zopu-<version> [--lingo ../lingo] [--publish]')
  process.exit(1)
}
const publish = process.argv.includes('--publish')
const lingoRoot = path.resolve(root, arg('lingo', '../lingo'))
const out = path.join(root, '.zopu-release', tag)
const base = `https://github.com/${REPO}/releases/download/${tag}`

// fork packages, in build order; the name in the release is the folder name
const PASCAL = ['core', 'geometry-script', 'ifc-converter', 'viewer', 'nodes', 'editor', 'mcp']
// third-party packages this fork patches (package.json patchedDependencies)
const PATCHED = { three: '0.187.0', 'three-bvh-csg': '0.0.18' }

const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
const read = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()

const files = {} // package name → release file
for (const p of PASCAL) files[`@pascal-app/${p}`] = `${p}.tgz`
files['@pascal-app/lingo'] = 'lingo.tgz'
for (const p of Object.keys(PATCHED)) files[p] = `${p}.tgz`
const urlOf = (name) => `${base}/${files[name]}`

for (const [dir, label] of [
  [root, 'editor fork'],
  [lingoRoot, 'lingo fork'],
]) {
  if (read('git', ['status', '--porcelain', '--untracked-files=no'], dir)) {
    console.error(`✗ The ${label} (${dir}) has uncommitted changes: a release is built from commits only.`)
    process.exit(1)
  }
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
const work = fs.mkdtempSync(path.join(out, '.work-'))

/** Unpack a tarball, point its links at the release, pack it again as `file`. */
function repack(tgz, file) {
  const dir = fs.mkdtempSync(path.join(work, 'pkg-'))
  run('tar', ['-xzf', tgz, '-C', dir])
  const pkgFile = path.join(dir, 'package', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(pkg[field] || {})) if (files[dep]) pkg[field][dep] = urlOf(dep)
  }
  // nothing runs on install, and nothing is published from the unpacked copy
  delete pkg.scripts
  pkg.zopu = { release: tag, from: pkg.name.startsWith('@pascal-app/lingo') ? 'roshanbvadassery/lingo' : REPO }
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
  run('tar', ['-czf', path.join(out, file), '-C', dir, 'package'])
}

function npmPack(cwd) {
  const name = read('npm', ['pack', '--ignore-scripts', '--pack-destination', work, '--silent'], cwd).split('\n').pop()
  return path.join(work, name)
}

// 1. build
console.log('▸ building lingo (fork)')
run('bunx', ['turbo', 'run', 'build', '--filter=@pascal-app/lingo'], lingoRoot)
console.log('▸ building the editor fork packages')
run('bunx', ['turbo', 'run', 'build', ...PASCAL.filter((p) => p !== 'editor').map((p) => `--filter=@pascal-app/${p}`)])

// 2. pack
repack(npmPack(path.join(lingoRoot, 'packages/lingo')), files['@pascal-app/lingo'])
for (const p of PASCAL) repack(npmPack(path.join(root, 'packages', p)), files[`@pascal-app/${p}`])
for (const [name, version] of Object.entries(PATCHED)) {
  // the upstream release with our patch on top, as bun applies it in the fork
  const tgz = path.join(work, read('npm', ['pack', `${name}@${version}`, '--pack-destination', work, '--silent']).split('\n').pop())
  const dir = fs.mkdtempSync(path.join(work, 'patch-'))
  run('tar', ['-xzf', tgz, '-C', dir])
  run('patch', ['-p1', '--forward', '-i', path.join(root, 'patches', `${name}@${version}.patch`)], path.join(dir, 'package'))
  const patched = path.join(work, `${name}-patched.tgz`)
  run('tar', ['-czf', patched, '-C', dir, 'package'])
  repack(patched, files[name])
}
fs.rmSync(work, { recursive: true, force: true })

// 3. manifest
const manifest = {
  tag,
  editorCommit: read('git', ['rev-parse', 'HEAD']),
  lingoCommit: read('git', ['rev-parse', 'HEAD'], lingoRoot),
  packages: Object.fromEntries(
    Object.entries(files).map(([name, file]) => {
      const bytes = fs.readFileSync(path.join(out, file))
      return [name, { url: urlOf(name), integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`, size: bytes.length }]
    }),
  ),
}
fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`✓ ${Object.keys(files).length} packages in ${out}`)

// 4. release
if (publish) {
  const notes = [
    `Zopu's pinned build: editor ${manifest.editorCommit.slice(0, 8)}, lingo ${manifest.lingoCommit.slice(0, 8)} (roshanbvadassery/lingo).`,
    '',
    ...Object.entries(manifest.packages).map(([name, p]) => `- \`${name}\`: ${p.url}`),
  ].join('\n')
  run('gh', [
    'release', 'create', tag, '--repo', REPO, '--target', manifest.editorCommit, '--title', tag, '--notes', notes,
    ...Object.values(files).map((f) => path.join(out, f)),
    path.join(out, 'manifest.json'),
  ])
}
