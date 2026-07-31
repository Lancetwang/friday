export function normalizeMarkdownMath(markdown: string) {
  let fence = ''
  return markdown.split('\n').map(line => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1] || ''
    if (marker) {
      if (!fence) fence = marker[0]
      else if (marker[0] === fence) fence = ''
      return line
    }
    return fence ? line : normalizeLine(line)
  }).join('\n')
}

function normalizeLine(line: string) {
  let codeTicks = 0
  let output = ''
  for (let index = 0; index < line.length;) {
    if (line[index] === '`') {
      let end = index + 1
      while (line[end] === '`') end += 1
      const count = end - index
      if (!codeTicks) codeTicks = count
      else if (codeTicks === count) codeTicks = 0
      output += line.slice(index, end)
      index = end
      continue
    }
    const delimiter = line.slice(index, index + 2)
    if (!codeTicks && (delimiter === '\\(' || delimiter === '\\)')) {
      output += '$'
      index += 2
      continue
    }
    if (!codeTicks && (delimiter === '\\[' || delimiter === '\\]')) {
      output += '\n$$\n'
      index += 2
      continue
    }
    output += line[index]
    index += 1
  }
  return output
}
