import { db } from './db'
import type { VaultTree } from './types'
import { safeUrl } from './util'

/**
 * Bridge between the app and "a folder of files on disk".
 *
 * Two paths, because browsers give us two different powers:
 *  - File System Access API (desktop Chrome/Edge): read AND write a real folder,
 *    and we can remember the folder handle so re-syncing is one click.
 *  - <input type="file" webkitdirectory> (everything else, incl. Android Chrome):
 *    read-only import of a picked folder. Works on a phone.
 * The folder is meant to sit inside Syncthing / OneDrive / iCloud Drive, which is
 * what actually moves it between PC and phone.
 */

/* ------------------------------------------------------------ types we need */

interface HandleBase {
  name: string
  kind: 'file' | 'directory'
  queryPermission?: (d: { mode: string }) => Promise<PermissionState>
  requestPermission?: (d: { mode: string }) => Promise<PermissionState>
  getFile: () => Promise<File>
  getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<DirHandle>
  getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<HandleBase & { createWritable: () => Promise<Writable> }>
  removeEntry: (name: string, opts?: { recursive?: boolean }) => Promise<void>
}
interface Writable {
  write: (data: string | Blob) => Promise<void>
  close: () => Promise<void>
}
export interface DirHandle extends HandleBase {
  values: () => AsyncIterableIterator<HandleBase>
}
type FsWindow = Window & { showDirectoryPicker?: (o?: { mode?: string }) => Promise<DirHandle> }

export const canPickFolder = () => typeof (window as FsWindow).showDirectoryPicker === 'function'

/* ------------------------------------------------------- remembering folder */

/** FileSystemDirectoryHandle is structured-cloneable, so IndexedDB can keep it for us. */
export async function saveFolderHandle(handle: DirHandle) {
  await db.meta.put({ key: 'vaultFolder', handle })
}

export async function loadFolderHandle(): Promise<DirHandle | null> {
  const row = await db.meta.get('vaultFolder')
  const handle = row?.handle as DirHandle | undefined
  if (!handle) return null
  try {
    const state = await handle.queryPermission?.({ mode: 'readwrite' })
    if (state !== 'granted') return { handle, needsPermission: true } as unknown as DirHandle
    return handle
  } catch {
    return null
  }
}

export async function ensurePermission(handle: DirHandle): Promise<boolean> {
  try {
    if ((await handle.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true
    return (await handle.requestPermission?.({ mode: 'readwrite' })) === 'granted'
  } catch {
    return false
  }
}

export async function pickFolder(): Promise<DirHandle | null> {
  const w = window as FsWindow
  if (!w.showDirectoryPicker) return null
  const handle = await w.showDirectoryPicker({ mode: 'readwrite' })
  await saveFolderHandle(handle)
  return handle
}

/* ---------------------------------------------------------------- writing */

async function writeRelPath(root: DirHandle, relPath: string, text: string) {
  const parts = relPath.split('/')
  const name = parts.pop()!
  let dir = root
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true })
  const fh = await dir.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(text)
  await w.close()
}

export async function writeFilesToFolder(root: DirHandle, files: { path: string; text: string }[]) {
  let removed = 0
  for (const f of files) {
    if (!f.text.trim() && !f.path.endsWith('.gitkeep')) continue
    await writeRelPath(root, f.path, f.text)
    removed++
  }
  return removed
}

/* ---------------------------------------------------------------- reading */

async function walkDir(dir: DirHandle, prefix: string, depth = 0, out: Map<string, string> = new Map()) {
  if (depth > 4) return out
  for await (const entry of dir.values()) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.kind === 'directory') {
      if (entry.name.startsWith('.')) continue
      await walkDir(entry as DirHandle, path, depth + 1, out)
    } else if (/\.(md|markdown|json)$/i.test(entry.name)) {
      const file = await entry.getFile()
      out.set(path, await file.text())
    }
  }
  return out
}

export async function readFolderAsTree(root: DirHandle): Promise<{ tree: VaultTree; files: Map<string, string> }> {
  const files = await walkDir(root, '')
  return { tree: filesToTree(files), files }
}

/** Subject folders > topic folders > .md files. Loose .md files at root are ignored. */
export function filesToTree(files: Map<string, string>): VaultTree {
  const subjects = new Map<string, Map<string, { title: string; text: string }[]>>()
  const ensure = (s: string) => {
    if (!subjects.has(s)) subjects.set(s, new Map())
    return subjects.get(s)!
  }
  for (const [path, text] of files) {
    if (path.endsWith('notes.vault.json')) continue
    const parts = path.split('/')
    if (parts.length < 3 || !/\.md$/i.test(parts[parts.length - 1]!)) continue
    const [subject, topic, ...rest] = parts
    const file = rest[rest.length - 1]!
    const title = file.replace(/\.md$/i, '')
    const topics = ensure(subject!)
    if (!topics.has(topic!)) topics.set(topic!, [])
    topics.get(topic!)!.push({ title, text })
    // alphabetical inside a topic folder, so the order does not depend on the file system
  }
  // Folder order from disk is kept as-is: your sync tool / file manager ordering wins.
  return {
    subjects: [...subjects.entries()].map(([name, topics]) => ({
      name,
      topics: [...topics.entries()].map(([topicName, notes]) => ({
        name: topicName,
        notes: [...notes].sort((a, b) => a.title.localeCompare(b.title)),
      })),
    })),
  }
}

/* --------------------------------------------- input fallback (phones too) */

/** Lets the user pick a folder with a plain <input>, which mobile browsers support. */
export function pickFolderWithInput(): Promise<{ tree: VaultTree; files: Map<string, string> } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.setAttribute('webkitdirectory', '')
    input.setAttribute('directory', '')
    input.multiple = true
    input.accept = '.md,.markdown,.json'
    input.style.display = 'none'
    document.body.append(input)
    let settled = false
    input.addEventListener('change', async () => {
      const files = new Map<string, string>()
      for (const f of Array.from(input.files ?? [])) {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
        files.set(rel, await f.text())
      }
      settled = true
      input.remove()
      resolve(files.size ? { tree: filesToTree(files), files } : null)
    })
    // There is no reliable "user cancelled" event; if nothing happened soon after
    // focus returns, treat it as a cancel.
    const onFocus = () => {
      setTimeout(() => {
        if (!settled) {
          input.remove()
          resolve(null)
        }
        window.removeEventListener('focus', onFocus)
      }, 800)
    }
    window.addEventListener('focus', onFocus)
    input.click()
  })
}

export function downloadText(filename: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/* ------------------------------------------------------------------ links */

export interface LinkInfo {
  url: string
  host: string
  kind: 'video' | 'article' | 'paper' | 'doc' | 'link'
  embedUrl?: string
  poster?: string
  videoId?: string
}

const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'twitch.tv', 'streamable.com']
const PAPER_HOSTS = ['arxiv.org', 'acm.org', 'ieee.org', 'nature.com', 'sciencedirect.com', 'biorxiv.org', 'openreview.net']
const DOC_HOSTS = ['docs.google.com', 'notion.so', 'figma.com', 'github.com', 'gitlab.com']

export function linkInfo(raw: string): LinkInfo {
  const url = safeUrl(raw)
  let host = ''
  let pathname = ''
  try {
    const u = new URL(url)
    host = u.hostname.replace(/^www\./, '')
    pathname = u.pathname
  } catch {
    host = url.replace(/^https?:\/\//, '').split('/')[0] ?? ''
  }
  const root = host.split('.').slice(-2).join('.')
  let kind: LinkInfo['kind'] = 'link'
  let embedUrl: string | undefined
  let poster: string | undefined
  let videoId: string | undefined

  const yt =
    host === 'youtu.be'
      ? pathname.slice(1).split('/')[0]
      : (url.match(/[?&]v=([\w-]{6,})/) || pathname.match(/^\/(?:shorts|embed)\/([\w-]{6,})/))?.[1]
  if (VIDEO_HOSTS.includes(root)) {
    kind = 'video'
    if (host.includes('youtube') && yt) {
      videoId = yt
      embedUrl = `https://www.youtube-nocookie.com/embed/${yt}`
      poster = `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`
    } else if (host.includes('vimeo')) {
      const id = pathname.match(/(\d+)/)?.[1]
      videoId = id
      if (id) embedUrl = `https://player.vimeo.com/video/${id}`
    }
  } else if (PAPER_HOSTS.includes(root)) kind = 'paper'
  else if (DOC_HOSTS.includes(root)) kind = 'doc'
  else if (/(\/blog\/|\/article\/|\/posts?\/|medium\.com|substack|\/news\/|\/read\/)/i.test(host + pathname)) kind = 'article'

  return { url, host, kind, embedUrl, poster, videoId }
}

export const faviconUrl = (host: string) => `https://duckduckgo.com/icons/?q=${encodeURIComponent(host)}&sz=64`

export const defaultLabelForUrl = (raw: string) => {
  try {
    const u = new URL(safeUrl(raw))
    const last = u.pathname.split('/').filter(Boolean).at(-1)
    const nice = last
      ? decodeURIComponent(last)
          .replace(/\.\w{2,4}$/, '')
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase())
      : ''
    return nice || u.hostname.replace(/^www\./, '')
  } catch {
    return raw
  }
}

/* ------------------------------------------------------------------ images */

/** Downscale + recompress pasted images so the vault stays small enough to sync. */
export async function fileToImageSrc(file: File, maxSide = 1600, quality = 0.82): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return await readAsDataUrl(file)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return await readAsDataUrl(file)
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  const hasAlpha = /png|webp|gif|svg/.test(file.type)
  return canvas.toDataURL(hasAlpha ? 'image/png' : 'image/jpeg', quality)
}

export const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(file)
  })
