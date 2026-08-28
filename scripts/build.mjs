#!/usr/bin/env node
/**
 * Portable DSH plugin build helper.
 *
 * The plugin is intentionally dependency-light: use the project's own
 * node_modules first, then link only the DSH packages needed for typechecking
 * from DSH_CHECKOUT / DSH_GLOBAL_NODE_MODULES / common user-level installs.
 * Existing installed packages are never replaced.
 *
 * Modes:
 *   node scripts/build.mjs                 compile host and copy client
 *   node scripts/build.mjs --no-emit       typecheck only
 *   node scripts/build.mjs --client-only   copy the hand-written client only
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const noEmit = args.includes('--no-emit')
const clientOnly = args.includes('--client-only')
const positional = args.filter((arg) => !arg.startsWith('--'))
const ROOT = path.resolve(positional[0] ?? process.cwd())
process.chdir(ROOT)

const packageJsonPath = path.join(ROOT, 'package.json')
if (!existsSync(packageJsonPath)) throw new Error(`build: package.json not found under ${ROOT}`)

function unique(paths) {
  return [...new Set(paths.filter(Boolean).map((value) => path.resolve(value)))]
}

function nodeModulesFromCheckout(value) {
  if (!value) return []
  const resolved = path.resolve(value)
  return [
    path.basename(resolved) === 'node_modules' ? resolved : path.join(resolved, 'node_modules'),
    resolved,
  ]
}

const globalRoots = unique([
  process.env.DSH_GLOBAL_NODE_MODULES,
  ...nodeModulesFromCheckout(process.env.DSH_CHECKOUT),
  path.join(os.homedir(), '.bun', 'install', 'global', 'node_modules'),
  path.join(os.homedir(), '.npm', 'node_modules'),
])
const localNodeModules = path.join(ROOT, 'node_modules')
const packageLinks = [
  ['@deepseek-ai/cordis', '@deepseek-ai/cordis'],
  ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent'],
  ['@deepseek-ai/dsh-attachment', '@deepseek-ai/dsh-attachment'],
  ['@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-brand'],
  ['@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-commands'],
  ['@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-home-paths'],
  ['@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-host-webserver'],
  ['@deepseek-ai/dsh-invariants', '@deepseek-ai/dsh-invariants'],
  ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm'],
  ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session'],
  ['@deepseek-ai/dsh-timeout', '@deepseek-ai/dsh-timeout'],
  ['@deepseek-ai/schemastery', '@deepseek-ai/schemastery'],
  ['@types/node', '@types/node'],
  ['typescript', 'typescript'],
]

function pathState(filePath) {
  try {
    const stat = lstatSync(filePath)
    return { exists: true, usable: existsSync(filePath), directory: stat.isDirectory() || stat.isSymbolicLink() }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, usable: false, directory: false }
    throw error
  }
}

function linkIfMissing(name, sourceName) {
  const destination = path.join(localNodeModules, name)
  const current = pathState(destination)
  if (current.usable) return
  if (current.exists) {
    throw new Error(`build: ${destination} exists but is not usable; repair it manually instead of replacing it`)
  }
  const source = globalRoots.map((root) => path.join(root, sourceName)).find((candidate) => existsSync(candidate))
  if (!source) return
  mkdirSync(path.dirname(destination), { recursive: true })
  symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`linked ${name} -> ${source}`)
}

function prepareDependencies() {
  mkdirSync(localNodeModules, { recursive: true })
  for (const [name, sourceName] of packageLinks) linkIfMissing(name, sourceName)
  const missing = packageLinks
    .map(([name]) => path.join(localNodeModules, name))
    .filter((filePath) => !existsSync(filePath))
  if (missing.length > 0) {
    throw new Error(`build: missing dependencies: ${missing.map((filePath) => path.relative(ROOT, filePath)).join(', ')}; run npm install or set DSH_CHECKOUT`)
  }
}

function runTsc(extra) {
  const tsc = path.join(localNodeModules, 'typescript', 'bin', 'tsc')
  if (!existsSync(tsc)) throw new Error(`build: TypeScript compiler not found at ${tsc}`)
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', ...extra], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

prepareDependencies()
if (clientOnly) {
  mkdirSync(path.join(ROOT, 'lib'), { recursive: true })
  copyFileSync(path.join(ROOT, 'src', 'client.js'), path.join(ROOT, 'lib', 'client.js'))
  console.log('copied src/client.js -> lib/client.js')
} else {
  console.log(noEmit ? 'typechecking host sources' : 'compiling host sources')
  runTsc(noEmit ? ['--noEmit'] : [])
  if (!noEmit) {
    mkdirSync(path.join(ROOT, 'lib'), { recursive: true })
    copyFileSync(path.join(ROOT, 'src', 'client.js'), path.join(ROOT, 'lib', 'client.js'))
    console.log('copied src/client.js -> lib/client.js')
  }
}
console.log('build complete')
