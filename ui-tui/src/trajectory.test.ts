import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TrajectoryWriter, writeTrajectory } from './trajectory.js'

test('a failed snapshot does not poison later queued saves', async () => {
  let current = 1
  const saved: unknown[] = []
  const writer = new TrajectoryWriter('unused', () => current, async (_path, value) => {
    if (value === 1) throw new Error('disk temporarily unavailable')
    saved.push(value)
  })
  const failed = assert.rejects(writer.flush(), /disk temporarily unavailable/)
  current = 2
  const recovered = writer.flush()
  await failed
  await recovered
  assert.deepEqual(saved, [2])
})

test('temporary rename contention preserves the previous snapshot and retries atomically', async context => {
  const root = await fs.mkdtemp(join(tmpdir(), 'friday-trajectory-contention-'))
  const path = join(root, 'trajectory.json')
  await fs.writeFile(path, JSON.stringify({ status: 'previous' }))
  const rename = fs.rename
  let attempts = 0
  context.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    attempts++
    if (attempts <= 3) {
      assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), { status: 'previous' })
      throw Object.assign(new Error('file in use'), { code: ['EBUSY', 'EPERM', 'EACCES'][attempts - 1] })
    }
    await rename(source, destination)
  })
  syncBuiltinESMExports()
  try {
    await writeTrajectory(path, { status: 'latest' })
    assert.equal(attempts, 4)
    assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), { status: 'latest' })
    assert.deepEqual(await fs.readdir(root), ['trajectory.json'])
  } finally {
    context.mock.restoreAll()
    syncBuiltinESMExports()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('scheduled write errors are reported and the final flush can recover', async () => {
  let current = 1
  let report!: (error: unknown) => void
  const reported = new Promise<unknown>(resolve => { report = resolve })
  const saved: unknown[] = []
  const writer = new TrajectoryWriter('unused', () => current, async (_path, value) => {
    if (value === 1) throw new Error('disk temporarily unavailable')
    saved.push(value)
  }, report)
  writer.schedule(true)
  assert.match(String(await reported), /disk temporarily unavailable/)
  current = 2
  await writer.flush()
  assert.deepEqual(saved, [2])
})

test('permanent rename failures remain visible and leave the previous snapshot intact', async context => {
  const root = await fs.mkdtemp(join(tmpdir(), 'friday-trajectory-failure-'))
  const path = join(root, 'trajectory.json')
  await fs.writeFile(path, JSON.stringify({ status: 'previous' }))
  let attempts = 0
  context.mock.method(fs, 'rename', async () => {
    attempts++
    throw Object.assign(new Error('file remains locked'), { code: 'EPERM' })
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(writeTrajectory(path, { status: 'latest' }), { code: 'EPERM' })
    assert.equal(attempts, 6)
    assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), { status: 'previous' })
    assert.deepEqual(await fs.readdir(root), ['trajectory.json'])
  } finally {
    context.mock.restoreAll()
    syncBuiltinESMExports()
    await fs.rm(root, { recursive: true, force: true })
  }
})
