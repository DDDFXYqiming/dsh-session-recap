import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const root = process.env.DSH_UPSTREAM_ROOT
if (!root) throw new Error('DSH_UPSTREAM_ROOT must point to a deepseek-ai/deepseek-harness Git checkout')

const ref = process.env.DSH_UPSTREAM_REF || 'dsh-v0.1.6-alpha.1'
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
const show = (path) => git('show', `${ref}:${path}`)

test('official GitHub source baseline resolves to a commit', () => {
  assert.match(git('rev-parse', ref), /^[0-9a-f]{40}$/)
})

test('official compact checkpoint remains distinguishable from user input', () => {
  const source = show('packages/compaction/compaction/src/checkpoint.ts')
  assert.match(source, /plugin: 'compact'/)
  assert.match(source, /source\.kind === 'plugin'/)
  assert.match(source, /source\.plugin === COMPACT_CHECKPOINT_MARKER\.plugin/)
})

test('official command UI supports a styled client contribution and command success text', () => {
  const clientContract = show('packages/client/ui-commands/src/client/contract.ts')
  const commandTypes = show('packages/interaction/commands/src/types.ts')
  assert.match(clientContract, /register\(contribution: CommandContribution\): \(\) => void/)
  assert.match(clientContract, /label\?\(\): string/)
  assert.match(clientContract, /readonly icon\?: ComponentType<IconProps>/)
  assert.match(commandTypes, /kind: 'success'[\s\S]*text\?: string/)
})

test('official session projection API replaces new direct event snapshots', () => {
  const projection = show('packages/session/session-projection/src/index.ts')
  const sessionDocs = show('docs/subsystems/session.md')
  assert.match(projection, /register<[\s\S]*ProjectionDefinition/)
  assert.match(projection, /stateOf<K extends keyof SessionProjectionStateMap>/)
  assert.match(sessionDocs, /@deprecated Existing logic may remain unmigrated for now, but new calls are prohibited\.[\s\S]*snapshotEvents/)
})
