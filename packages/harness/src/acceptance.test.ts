import assert from 'node:assert/strict'
import test from 'node:test'
import { RunContext } from 'friday-agent-core'
import { acceptanceFor, validateAcceptance } from './acceptance.js'
import { beginProgress, currentProgress, recordVerificationProgress, restoreProgress, updatePlan } from './progress.js'
import { enforceAcceptance, parseVerification, verifyGoal } from './verification.js'

const contract = acceptanceFor('Deliver both files', [{ id: 'files', description: 'Both files exist' }, { id: 'content', description: 'Both files contain the requested values' }])
const passing = () => parseVerification(JSON.stringify({ verdict: 'pass', evidence: ['all checks [tool:read]'],
  criteria: contract.map(item => ({ id: item.id, verdict: 'pass', evidence: ['inspected [tool:read]'] })) }))

test('global pass requires exact contract coverage and independent successful evidence for each item', () => {
  const success = new Set(['read'])
  assert.equal(enforceAcceptance(passing(), contract, success).verdict, 'pass')
  for (const mutation of ['missing', 'duplicate', 'unknown', 'failed', 'unproven', 'main-agent-evidence']) {
    const parsed = passing()
    if (mutation === 'missing') parsed.criteria!.pop()
    if (mutation === 'duplicate') parsed.criteria![1]!.id = 'goal'
    if (mutation === 'unknown') parsed.criteria![1]!.id = 'invented'
    if (mutation === 'failed') parsed.criteria![1]!.verdict = 'repair'
    if (mutation === 'unproven') parsed.criteria![1]!.evidence = ['looks good']
    if (mutation === 'main-agent-evidence') parsed.criteria![1]!.evidence = ['main agent checked [tool:foreign]']
    assert.equal(enforceAcceptance(parsed, contract, success).verdict, 'inconclusive', mutation)
  }
  assert.equal(enforceAcceptance(passing(), contract, success, false).passed, false)
  const answer = parseVerification('{"verdict":"pass","evidence":["delivered [answer]"]}')
  assert.equal(enforceAcceptance(answer, acceptanceFor('Explain'), new Set()).passed, false)
  assert.equal(enforceAcceptance(answer, acceptanceFor('Explain'), new Set(), true, 'delivered').passed, true)
})

test('goal contract remains intact through plan edits, verification, continuation and restoration', () => {
  const context = new RunContext()
  beginProgress(context, 'Deliver both files', 'goal', false, contract)
  updatePlan(context, { objective: 'Deliver only one file', plan: [{ step: 'one', status: 'completed' }] })
  recordVerificationProgress(context, { verdict: 'pass', attempt: 1, criteria: passing().criteria })
  beginProgress(context, 'repair only one file', 'goal', true)
  const saved = currentProgress(context)!
  assert.equal(saved.objective, 'Deliver both files'); assert.deepEqual(saved.acceptance, contract)
  const restored = new RunContext(); restoreProgress(restored, saved)
  assert.deepEqual(currentProgress(restored)?.acceptance, contract)
  assert.deepEqual(currentProgress(restored)?.verification.criteria, passing().criteria)
  assert.throws(() => validateAcceptance([{ id: 'goal', description: 'replace' }]), /reserved/)
  assert.throws(() => validateAcceptance([{ id: 'x', description: 'a' }, { id: 'x', description: 'b' }]), /unique/)
})

test('verifier receives the frozen contract and rejects model omission on its actual run path', async () => {
  let prompt = ''
  const result = await verifyGoal({ workspace: process.cwd(), config: { profileId: 'test', profileName: 'Test', provider: 'openai-compatible', model: 'mock',
    baseUrl: 'http://127.0.0.1:9', apiKey: '', contextWindow: 32768, maxOutputTokens: 1024 }, thinking: '', goal: 'Deliver both files', criteria: contract,
    model: { async complete(request) { prompt = JSON.stringify(request.messages); return { role: 'assistant', content: '{"verdict":"pass","evidence":["looks done"]}' } } } })
  assert.match(prompt, /Both files contain/); assert.equal(result.verdict, 'inconclusive')
  assert.equal(result.criteria?.length, 3)
})
