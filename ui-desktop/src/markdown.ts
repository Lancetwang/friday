/** Everything Friday's markdown needs before CommonMark sees it. */
export function normalizeMarkdown(markdown: string) {
  // Emphasis first: math normalization introduces `$`, which the emphasis rule
  // would then read as trailing punctuation.
  return normalizeMarkdownMath(normalizeMarkdownEmphasis(markdown))
}

export function normalizeMarkdownMath(markdown: string) {
  return mapProse(markdown, mathDelimiters)
}

export function normalizeMarkdownEmphasis(markdown: string) {
  return mapProse(markdown, closableBold)
}

/**
 * Bold that CommonMark refuses to close, rewritten so it closes.
 *
 * A closing `**` is only a closer if the character before it is not punctuation,
 * or the character after it is a space or punctuation. `**注意：**内容` satisfies
 * neither, so the asterisks are printed literally -- and that is ordinary
 * Chinese, where nothing separates a phrase from what follows it. English is
 * mostly spared because `**Note:** ...` puts a space there.
 *
 * The punctuation the author put inside the phrase ends it either way, so moving
 * it just outside the closing run renders what they meant.
 */
const UNCLOSABLE_BOLD = /\*\*(?![\s*])([^*]*?)([\p{P}\p{S}]+)\*\*(?=[^\s*\p{P}\p{S}])/gu

function closableBold(text: string) {
  return text.replace(UNCLOSABLE_BOLD, (match, body: string, tail: string) =>
    body.trim() ? `**${body}**${tail}` : match)
}

function mathDelimiters(text: string) {
  let output = ''
  for (let index = 0; index < text.length;) {
    const delimiter = text.slice(index, index + 2)
    if (delimiter === '\\(' || delimiter === '\\)') {
      output += '$'
      index += 2
      continue
    }
    if (delimiter === '\\[' || delimiter === '\\]') {
      output += '\n$$\n'
      index += 2
      continue
    }
    output += text[index]
    index += 1
  }
  return output
}

/** Run `transform` over the prose of a document, leaving code exactly as written. */
function mapProse(markdown: string, transform: (text: string) => string) {
  let fence = ''
  return markdown.split('\n').map(line => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1] || ''
    if (marker) {
      if (!fence) fence = marker[0]
      else if (marker[0] === fence) fence = ''
      return line
    }
    return fence ? line : mapLineProse(line, transform)
  }).join('\n')
}

function mapLineProse(line: string, transform: (text: string) => string) {
  let output = ''
  let prose = ''
  let ticks = 0
  for (let index = 0; index < line.length;) {
    if (line[index] !== '`') {
      if (ticks) output += line[index]
      else prose += line[index]
      index += 1
      continue
    }
    let end = index + 1
    while (line[end] === '`') end += 1
    const count = end - index
    if (!ticks) {
      // Each prose run is transformed on its own, so a construct cannot be
      // assembled out of fragments that a code span sits between.
      output += transform(prose) + line.slice(index, end)
      prose = ''
      ticks = count
    } else {
      if (ticks === count) ticks = 0
      output += line.slice(index, end)
    }
    index = end
  }
  return output + transform(prose)
}
