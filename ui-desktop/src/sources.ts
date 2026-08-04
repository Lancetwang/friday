/**
 * Which web pages an assistant answer rests on.
 *
 * The chat shows this as the "Sources" chip under a reply. Search and fetch tool
 * results are the evidence; this turns them into one deduplicated, ordered list
 * per answer. Kept out of the view layer so the attribution rules can be tested
 * without rendering anything.
 */

export type WebSource = {
  icon?: string
  title: string
  url: string
}

/** The fields of a timeline entry that source attribution reads. */
export type SourceItem = {
  arguments?: string
  id: string
  kind: string
  name?: string
  text: string
}

export function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function safeIconUrl(value: unknown) {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function cleanSourceUrl(url: string) {
  return url.replace(/[)\].,;:!?'"]+$/, '')
}

function normalizeSourceTitle(title: string, url: string) {
  const clean = title.trim()
  if (!clean || /^https?:\/\//i.test(clean)) return hostOf(url) || url
  return clean
}

function normalizeSourceUrl(url: string) {
  return cleanSourceUrl(url).replace(/\/+$/, '').toLowerCase()
}

function structuredSearchSources(text: string): WebSource[] {
  try {
    const value = JSON.parse(text) as { results?: unknown }
    if (!Array.isArray(value.results)) return []
    return value.results.flatMap(result => {
      if (!result || typeof result !== 'object') return []
      const item = result as { favicon?: unknown; title?: unknown; url?: unknown }
      if (typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) return []
      return [{
        icon: safeIconUrl(item.favicon) || undefined,
        title: typeof item.title === 'string' ? item.title : hostOf(item.url),
        url: item.url
      }]
    })
  } catch {
    return []
  }
}

function markdownLinks(text: string): WebSource[] {
  const links: WebSource[] = []
  for (const match of text.matchAll(/\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)/g)) {
    links.push({ title: match[1]!.trim(), url: cleanSourceUrl(match[2]!) })
  }
  return links
}

function bareUrls(text: string): string[] {
  const urls: string[] = []
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    urls.push(cleanSourceUrl(match[0]))
  }
  return urls
}

function jsonUrl(text: string): string {
  try {
    const parsed = JSON.parse(text || '{}') as { url?: unknown }
    return typeof parsed.url === 'string' && /^https?:\/\//i.test(parsed.url) ? parsed.url : ''
  } catch {
    return ''
  }
}

function toolSources(item: SourceItem): WebSource[] {
  const name = (item.name || '').toLowerCase()
  // A fetch consulted exactly one page. Harvesting links out of the fetched body
  // instead would count a page's own navigation and ads as sources.
  if (name === 'webfetch') {
    const url = jsonUrl(item.arguments || '') || jsonUrl(item.text || '')
    return url ? [{ title: hostOf(url), url }] : []
  }
  if (name !== 'websearch') return []
  const structured = structuredSearchSources(item.text || '')
  if (structured.length) return structured
  // Providers without a structured payload return their results as text links.
  const sources = markdownLinks(item.text || '')
  for (const url of bareUrls(item.text || '')) sources.push({ title: hostOf(url), url })
  return sources
}

/**
 * Map each assistant message to the sources gathered since the previous message.
 *
 * Search happens in rounds, so the list is the union of every round in the turn
 * and is never truncated: a report built from forty pages should say forty.
 */
export function collectMessageSources(items: SourceItem[]) {
  const result = new Map<string, WebSource[]>()
  let pending: WebSource[] = []
  for (const item of items) {
    if (item.kind === 'user') {
      pending = []
      continue
    }
    if (item.kind === 'tool') {
      pending.push(...toolSources(item))
      continue
    }
    if (item.kind !== 'assistant') continue
    const seen = new Map<string, WebSource>()
    const merged: WebSource[] = []
    for (const source of [...markdownLinks(item.text), ...pending]) {
      const key = normalizeSourceUrl(source.url)
      if (!key) continue
      const existing = seen.get(key)
      if (existing) {
        if (!existing.icon && source.icon) existing.icon = source.icon
        continue
      }
      const normalized = {
        icon: safeIconUrl(source.icon) || undefined,
        title: normalizeSourceTitle(source.title, source.url),
        url: cleanSourceUrl(source.url)
      }
      seen.set(key, normalized)
      merged.push(normalized)
    }
    if (merged.length) result.set(item.id, merged)
    pending = []
  }
  return result
}
