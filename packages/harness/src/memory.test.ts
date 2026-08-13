import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Gateway } from './gateway.js'
import {
  addMemory,
  consolidateMemory,
  captureUserMemory,
  listMemories,
  relevantMemory,
  removeMemory,
  runMemoryCommand,
  searchMemories,
  updateMemory
} from './memory.js'

test('Markdown memory stays compatible with Python and supports its lifecycle', async () => {
  await withWorkspace(async (home, workspace) => {
    const manual = 'Hand-written preference.'
    const manualId = createHash('sha256').update(`global\0${manual}`).digest('hex').slice(0, 12)
    await writeFile(join(home, 'MEMORY.md'), `# User Memory\n\n- ${manual}\n`)

    const added = await addMemory(workspace, 'user', 'Preferred language is Chinese.', { source: 'user' })
    const duplicate = await addMemory(workspace, 'user', 'Preferred language is Chinese.', { source: 'user' })
    assert.equal(duplicate.id, added.id)
    assert.equal(duplicate.duplicate, true)
    assert.equal((await listMemories(workspace, 'global'))[0]?.id, manualId)
    assert.match(await readFile(join(home, 'USER.md'), 'utf8'), /<!-- friday-memory \{"id":"[a-f0-9]{12}"/)

    const updated = await updateMemory(workspace, added.id, 'Default response language is Chinese.')
    assert.equal(updated.content, 'Default response language is Chinese.')
    assert.equal((await searchMemories(workspace, 'Chinese', 'user'))[0]?.id, added.id)
    const removed = await removeMemory(workspace, added.id)
    assert.equal(removed.removed, true)
    assert.deepEqual(await listMemories(workspace, 'user'), [])
  })
})

test('memory capture is conservative, blocks secrets, and recalls episodic evidence', async () => {
  await withWorkspace(async (_home, workspace) => {
    const captured = await captureUserMemory(workspace, '以后请默认使用中文回答，不要写套话。', 's1')
    assert(captured)
    assert.match(await relevantMemory(workspace, '请用中文回答'), /默认使用中文回答/)
    assert.equal(await captureUserMemory(workspace, '帮我读取这个文件。'), undefined)
    assert.equal(await captureUserMemory(workspace, '记住我的 token=hf_abcdefghijklmnopqrstuvwxyz'), undefined)

    await captureUserMemory(workspace, '永远记住我喜欢使用中文。')
    await captureUserMemory(workspace, '始终记住这个项目不处理 TUI。')
    await captureUserMemory(workspace, '永远不要忘记本机默认使用 PowerShell。')
    assert.equal((await listMemories(workspace, 'user')).length, 1)
    assert.equal((await listMemories(workspace, 'project')).length, 1)
    assert.equal((await listMemories(workspace, 'global')).length, 1)
    assert.equal((await listMemories(workspace, 'episode')).length, 1)
  })
})

test('memory consolidation applies only validated operations and protects project scope', async () => {
  await withWorkspace(async (_home, workspace) => {
    const now = new Date(2026, 7, 13, 12, 0, 0)
    const episode = await addMemory(workspace, 'episode', 'I prefer terse status updates.', { date: now, count: 2 })
    const result = await consolidateMemory(workspace, 2, async payload => {
      assert.equal((payload.episodes as unknown[]).length, 1)
      return { operations: [{ action: 'promote', source_ids: [episode.id], content: episode.content, scope: 'user' }] }
    }, now)
    assert.deepEqual(result, { reviewed: 1, merged: 0, promoted: 1, remaining: 0 })
    assert.equal((await listMemories(workspace, 'user'))[0]?.content, episode.content)

    const other = join(workspace, '..', 'other-workspace')
    await mkdir(other)
    const foreign = await addMemory(other, 'episode', 'This project uses uv.', { date: now, count: 2 })
    const refused = await consolidateMemory(workspace, 2, async () => ({
      operations: [{ action: 'promote', source_ids: [foreign.id], content: foreign.content, scope: 'project' }]
    }), now)
    assert.equal(refused.promoted, 0)
    assert.deepEqual(await listMemories(workspace, 'project'), [])
  })
})

test('the gateway serves memory commands without requiring a configured model', async () => {
  await withWorkspace(async (_home, workspace) => {
    const output: unknown[] = []
    const gateway = new Gateway(workspace, value => output.push(value))
    await gateway.start()
    output.length = 0

    await gateway.handle({ id: 'add', method: 'memory.command', params: { command: 'add project Keep the harness small.' } })
    await gateway.handle({ id: 'status', method: 'memory.command', params: { command: 'status' } })
    await gateway.handle({ id: 'consolidate', method: 'memory.command', params: { command: 'consolidate --days 3' } })

    assert.match(responseText(output, 'add'), /Saved memory/)
    assert.match(responseText(output, 'status'), /Memory status/)
    assert.match(responseText(output, 'consolidate'), /Consolidated 0 episodic notes/)
    const listed = await runMemoryCommand('list project', workspace) as { memories: unknown[] }
    assert.equal(listed.memories.length, 1)
  })
})

async function withWorkspace(work: (home: string, workspace: string) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'friday-memory-'))
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  const previous = process.env.FRIDAY_HOME
  await mkdir(home)
  await mkdir(workspace)
  process.env.FRIDAY_HOME = home
  try { await work(home, workspace) } finally {
    if (previous === undefined) delete process.env.FRIDAY_HOME
    else process.env.FRIDAY_HOME = previous
    await rm(temporary, { recursive: true, force: true })
  }
}

function responseText(output: unknown[], id: string): string {
  const message = output.find(value => (value as { id?: unknown }).id === id) as { result?: { text?: unknown }; error?: unknown } | undefined
  assert(message && !message.error, `Missing successful response ${id}.`)
  const result = message.result
  assert(result)
  assert.equal(typeof result.text, 'string')
  return result.text as string
}
