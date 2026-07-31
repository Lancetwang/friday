import assert from 'node:assert/strict'

import { normalizeMarkdownMath } from '../src/markdown.ts'

assert.equal(normalizeMarkdownMath('Inline \\(x^2\\).'), 'Inline $x^2$.')
assert.equal(normalizeMarkdownMath('Before\\[\\frac{a}{b}\\]after'), 'Before\n$$\n\\frac{a}{b}\n$$\nafter')
assert.equal(normalizeMarkdownMath('`\\(raw\\)` and \\(math\\)'), '`\\(raw\\)` and $math$')
assert.equal(normalizeMarkdownMath('```tex\n\\frac{a}{b}\n```'), '```tex\n\\frac{a}{b}\n```')
assert.equal(normalizeMarkdownMath('Already $x$ and $$y$$'), 'Already $x$ and $$y$$')

console.log('markdown math normalization: OK')
