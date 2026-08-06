import assert from 'node:assert/strict'

import { micromark } from 'micromark'

import { normalizeMarkdown, normalizeMarkdownEmphasis, normalizeMarkdownMath } from '../src/markdown.ts'

assert.equal(normalizeMarkdownMath('Inline \\(x^2\\).'), 'Inline $x^2$.')
assert.equal(normalizeMarkdownMath('Before\\[\\frac{a}{b}\\]after'), 'Before\n$$\n\\frac{a}{b}\n$$\nafter')
assert.equal(normalizeMarkdownMath('`\\(raw\\)` and \\(math\\)'), '`\\(raw\\)` and $math$')
assert.equal(normalizeMarkdownMath('```tex\n\\frac{a}{b}\n```'), '```tex\n\\frac{a}{b}\n```')
assert.equal(normalizeMarkdownMath('Already $x$ and $$y$$'), 'Already $x$ and $$y$$')

console.log('markdown math normalization: OK')

// CommonMark will not close bold whose last character is punctuation when a
// letter follows the closing run. Chinese writes exactly that, with no space to
// separate the phrase from what comes next, so the asterisks were printed.
const bolded = (markdown: string) => micromark(normalizeMarkdown(markdown)).includes('<strong>')

assert.equal(normalizeMarkdownEmphasis('**注意：**这里要小心。'), '**注意**：这里要小心。')
assert.equal(normalizeMarkdownEmphasis('- **要点，**说明文字'), '- **要点**，说明文字')
assert.equal(normalizeMarkdownEmphasis('**Note:**follow up.'), '**Note**:follow up.')
assert.ok(bolded('**注意：**这里要小心。'))
assert.ok(bolded('**说明。**下一句继续。'))

// Only the construction that could not close is touched.
assert.equal(normalizeMarkdownEmphasis('**注意**：这里'), '**注意**：这里')
assert.equal(normalizeMarkdownEmphasis('**Note:** follow up.'), '**Note:** follow up.')
assert.equal(normalizeMarkdownEmphasis('这是**加粗**文字。'), '这是**加粗**文字。')
// Nothing left inside the emphasis, so rewriting would produce empty bold.
assert.equal(normalizeMarkdownEmphasis('**：**内容'), '**：**内容')

// Code is quoted text: what it shows must be what was written.
assert.equal(normalizeMarkdownEmphasis('use `**注意：**内容` verbatim'), 'use `**注意：**内容` verbatim')
assert.equal(normalizeMarkdownEmphasis('```\n**注意：**内容\n```'), '```\n**注意：**内容\n```')

// Both passes run over one document without disturbing each other.
assert.equal(normalizeMarkdown('**注意：**见 \\(x^2\\) 公式'), '**注意**：见 $x^2$ 公式')

console.log('markdown emphasis normalization: OK')
