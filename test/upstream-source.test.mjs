import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const root = process.env.DSH_UPSTREAM_ROOT
if (!root) throw new Error('DSH_UPSTREAM_ROOT must point to a deepseek-ai/deepseek-harness Git checkout')

const ref = process.env.DSH_UPSTREAM_REF || 'origin/master'
const expectedCommit = '0d1f50007f9bca3f52b06e1c3074fa14d5fb0720'
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
const show = (path) => git('show', `${ref}:${path}`)

test('official GitHub source baseline is the reviewed commit', () => {
  assert.equal(git('rev-parse', ref), expectedCommit)
})

test('official compact checkpoint remains distinguishable from user input', () => {
  const source = show('packages/compaction/compaction/src/checkpoint.ts')
  assert.match(source, /plugin: 'compact'/)
  assert.match(source, /source\.kind === 'plugin'/)
  assert.match(source, /source\.plugin === COMPACT_CHECKPOINT_MARKER\.plugin/)
})

test('official command UI supports decoration and command success supports text', () => {
  const clientContract = show('packages/client/ui-commands/src/client/contract.ts')
  const commandTypes = show('packages/interaction/commands/src/types.ts')
  assert.match(clientContract, /decorate\(decoration: CommandDecoration\): \(\) => void/)
  assert.match(commandTypes, /kind: 'success'[\s\S]*text\?: string/)
})
