import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import { resolveWorkspace } from './config.js'

export type ArtifactInfo = { kind: 'image' | 'markdown' | 'pdf' | 'text'; name: string; path: string; size: number }
export type ArtifactDetail = ArtifactInfo & { content?: string; data_url?: string }

const TYPES: Record<string, ArtifactInfo['kind']> = {
  '.csv': 'text', '.gif': 'image', '.html': 'text', '.jpeg': 'image', '.jpg': 'image',
  '.json': 'text', '.md': 'markdown', '.markdown': 'markdown', '.pdf': 'pdf',
  '.png': 'image', '.txt': 'text', '.webp': 'image'
}
const MIMES: Record<string, string> = {
  '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf', '.png': 'image/png', '.webp': 'image/webp'
}

export async function checkpointArtifacts(workspace: string, paths: readonly string[]): Promise<ArtifactInfo[]> {
  const artifacts: ArtifactInfo[] = []
  for (const path of paths) {
    try {
      const detail = await artifactInfo(workspace, path)
      artifacts.push(detail)
      if (artifacts.length >= 24) break
    } catch {}
  }
  return artifacts
}

export async function artifactDetail(workspace: string, path: string): Promise<ArtifactDetail> {
  const info = await artifactInfo(workspace, path)
  if (info.size > 25 * 1024 * 1024) throw new Error('Artifact is too large to preview (25 MB limit).')
  const absolute = await containedFile(workspace, path)
  const content = await readFile(absolute)
  if (info.kind === 'markdown' || info.kind === 'text') return { ...info, content: content.toString('utf8') }
  const mime = MIMES[extname(absolute).toLowerCase()]
  if (!mime) throw new Error('This artifact type cannot be previewed safely.')
  return { ...info, data_url: `data:${mime};base64,${content.toString('base64')}` }
}

async function artifactInfo(workspace: string, path: string): Promise<ArtifactInfo> {
  const absolute = await containedFile(workspace, path)
  const kind = TYPES[extname(absolute).toLowerCase()]
  if (!kind) throw new Error('This artifact type cannot be previewed safely.')
  const size = (await stat(absolute)).size
  return {
    kind,
    name: basename(absolute),
    path: relative(resolveWorkspace(workspace), absolute).split(sep).join('/'),
    size
  }
}

async function containedFile(workspace: string, value: string): Promise<string> {
  if (!value || isAbsolute(value)) throw new Error('Artifact path must be relative to the workspace.')
  const root = resolveWorkspace(workspace)
  const candidate = resolve(root, value)
  const lexical = relative(root, candidate)
  if (!lexical || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new Error('Artifact is outside the workspace or no longer exists.')
  }
  let path: string
  try { path = await realpath(candidate) } catch {
    throw new Error('Artifact is outside the workspace or no longer exists.')
  }
  const rel = relative(root, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !(await stat(path)).isFile()) {
    throw new Error('Artifact is outside the workspace or no longer exists.')
  }
  return path
}
