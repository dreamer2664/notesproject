import type { Block, Note, Subject, Topic, Vault, VaultTree } from './types'
import { plainText } from './util'

/**
 * Markdown is the archive format: one .md file per note, one folder per subject,
 * one subfolder per topic. Everything this app can show can be expressed here,
 * and everything here can be read back in.
 */

const bullet = (type: Block['type']) => (type === 'bulleted' ? '-' : type === 'numbered' ? '1.' : type === 'todo' ? '- [ ]' : '')

const ENTITIES: [RegExp, string][] = [
  [/&nbsp;/g, ' '],
  [/&amp;/g, '&'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
]
const decode = (s: string) => ENTITIES.reduce((acc, [re, to]) => acc.replace(re, to), s)
const encodeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * note block HTML -> markdown inline text. The HTML inside a block is already
 * limited to b/i/u/s/code/a/br (see sanitizeHtml), so a tag-level rewrite is
 * exact and keeps this module free of any DOM dependency (testable in node).
 */
export function inlineToMd(html: string): string {
  if (!html) return ''
  let out = html
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<\/?(?:div|p)[^>]*>/gi, ' ')
  out = out.replace(/<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**')
  out = out.replace(/<(?:i|em)>([\s\S]*?)<\/(?:i|em)>/gi, '*$1*')
  out = out.replace(/<(?:s|strike|del)>([\s\S]*?)<\/(?:s|strike|del)>/gi, '~~$1~~')
  out = out.replace(/<code>([\s\S]*?)<\/code>/gi, (_m, c: string) => (c.includes('`') ? '`` ' + c + ' ``' : `\`${c}\``))
  out = out.replace(
    /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, text: string) => {
      const url = decode(href)
      const label = decode(text).replace(/\s+/g, ' ').trim()
      return `[${label || url}](${url})`
    },
  )
  out = out
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return decode(out)
}

/** markdown inline text -> the small HTML subset a block may contain. */
export function mdToInline(md: string): string {
  let out = encodeText(md ?? '')
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  out = out.replace(/(^|[^*\w])\*([^*]+)\*(?!\*)/g, '$1<i>$2</i>')
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  out = out.replace(/<u>([\s\S]*?)<\/u>/g, '<u>$1</u>')
  out = out.replace(
    /\[((?:[^\[\]]|\[[^\]]*\])*)\]\(<?(https?:\/\/[^)\s>]*)>?\)/g,
    (_m, text: string, url: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text || url}</a>`,
  )
  out = out.replace(/\[([^\]]*)\]\(\)/g, '$1')
  return out.trim()
}

export function blockToMd(b: Block): string {
  // two spaces per level, matching what the reader assumes when it counts leading spaces
  const pad = '  '.repeat(Math.min(4, b.indent ?? 0))
  switch (b.type) {
    case 'h1':
      return `# ${inlineToMd(b.content ?? '')}`
    case 'h2':
      return `## ${inlineToMd(b.content ?? '')}`
    case 'h3':
      return `### ${inlineToMd(b.content ?? '')}`
    case 'quote':
      return `${pad}> ${inlineToMd(b.content ?? '')}`
    case 'callout':
      return `${pad}> 💡 ${inlineToMd(b.content ?? '')}`
    case 'code':
      return '```\n' + (b.content ?? '').replace(/^```$/gm, '') + '\n```'
    case 'divider':
      return '---'
    case 'bulleted':
    case 'numbered':
      return `${pad}${bullet(b.type)} ${inlineToMd(b.content ?? '')}`
    case 'todo':
      return `${pad}- [${b.checked ? 'x' : ' '}] ${inlineToMd(b.content ?? '')}`
    case 'toggle':
      return `${pad}**${inlineToMd(b.content ?? '')}**`
    case 'image':
      return `![${b.alt ?? ''}](${b.src ?? ''})${b.caption ? `\n*${b.caption}*` : ''}`
    case 'link': {
      const bits = [
        `- **[${((b.label || b.url) ?? '').replace(/[[\]]/g, '')}](${b.url})**`,
        b.kind ? `kind: ${b.kind}` : '',
        b.read ? 'read' : 'unread',
        b.starred ? '⭐' : '',
        b.note ? `note: ${b.note.replace(/·/g, '-').trim()}` : '',
      ].filter(Boolean)
      return bits.join(' · ')
    }
    default:
      return `${pad}${inlineToMd(b.content ?? '')}`
  }
}

export const noteToMd = (note: Note) =>
  note.blocks
    .map(blockToMd)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n'

export function vaultToFiles(vault: Vault): { path: string; text: string }[] {
  const slug = (s: string) =>
    s
      .trim()
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/, '')
      .slice(0, 60) || 'untitled'
  const files: { path: string; text: string }[] = []
  const used = new Set<string>()
  const unique = (p: string) => {
    let out = p
    let i = 2
    while (used.has(out.toLowerCase())) out = `${p.replace(/\.md$/, ` ${i++}.md`)}`
    used.add(out.toLowerCase())
    return out
  }
  const topicsBySubject = new Map<string, Topic[]>()
  for (const t of vault.topics) {
    const list = topicsBySubject.get(t.subjectId) ?? []
    list.push(t)
    topicsBySubject.set(t.subjectId, list)
  }
  const notesByTopic = new Map<string, Note[]>()
  for (const n of vault.notes) {
    const list = notesByTopic.get(n.topicId) ?? []
    list.push(n)
    notesByTopic.set(n.topicId, list)
  }

  for (const subject of vault.subjects) {
    const sdir = slug(subject.name)
    const topics = (topicsBySubject.get(subject.id) ?? []).sort((a, b) => a.order - b.order)
    files.push({
      path: `${sdir}.folder.md`,
      text: [
        `# ${subject.name}`,
        '',
        ...topics.map((t) => `- [${t.name}.folder.md](${t.name}.folder.md) — ${notesByTopic.get(t.id)?.length ?? 0} notes`),
        '',
      ].join('\n'),
    })
    for (const topic of topics) {
      const tdir = `${sdir}/${slug(topic.name)}`
      const notes = (notesByTopic.get(topic.id) ?? []).sort((a, b) => b.updatedAt - a.updatedAt)
      for (const note of notes) files.push({ path: unique(`${tdir}/${slug(note.title)}.md`), text: noteToMd(note) })
      if (!notes.length) files.push({ path: `${tdir}/.gitkeep`, text: '' })
    }
  }
  files.push({ path: 'notes.vault.json', text: JSON.stringify(vault, null, 2) })
  return files
}

/* ------------------------------------------------------------- importing md */

export function mdToBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let fence: string[] | null = null
  const id = () => `b_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const push = (type: Block['type'], content: string, extra: Partial<Block> = {}) =>
    blocks.push({ id: id(), type, content, ...extra })

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (fence) {
      if (line.trim().startsWith('```')) {
        push('code', fence.join('\n'))
        fence = null
      } else fence.push(line)
      continue
    }
    if (line.trim().startsWith('```')) {
      fence = []
      continue
    }
    const indent = Math.min(4, Math.floor((raw.match(/^[ \t]*/)?.[0].length ?? 0) / 2))
    const t = line.trim()
    if (!t) continue
    let m: RegExpMatchArray | null
    if ((m = t.match(/^(#{1,3})\s+(.*)$/))) {
      const level = m[1]!.length
      push(level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3', mdToInline(m[2]!))
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      push('divider', '')
      continue
    }
    if ((m = t.match(/^>\s?(.*)$/))) {
      const text = m[1]!
      if (text.trimStart().startsWith('💡')) push('callout', mdToInline(text.trim().replace(/^💡\s*/, '')), { indent })
      else push('quote', mdToInline(text), { indent })
      continue
    }
    if ((m = t.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/))) {
      push('todo', mdToInline(m[2]!), { checked: m[1]!.toLowerCase() === 'x', indent })
      continue
    }
    if ((m = t.match(/^-\s+\*\*\[(.*?)\]\(<?(https?:\/\/[^)>\s]+)>?\)\*\*(.*)$/))) {
      const rest = m[3] ?? ''
      push('link', '', {
        label: m[1]!,
        url: m[2]!,
        kind: /kind:\s*video/.test(rest) ? 'video' : /kind:\s*article/.test(rest) ? 'article' : 'link',
        read: /·\s*read\b/.test(rest),
        starred: /⭐/.test(rest),
        embed: true,
        note: (rest.match(/note:\s*([^·]+)/)?.[1] ?? '').trim() || undefined,
        addedAt: Date.now(),
      })
      continue
    }
    // A bare markdown link on its own line becomes a link card.
    if ((m = t.match(/^\[(.*?)\]\(<?(https?:\/\/[^)>\s]+)>?\)\s*$/))) {
      push('link', '', { label: m[1] || m[2], url: m[2]!, embed: false, addedAt: Date.now() })
      continue
    }
    if ((m = t.match(/^[-*]\s+(.*)$/))) {
      push('bulleted', mdToInline(m[1]!), { indent })
      continue
    }
    if ((m = t.match(/^\d+[.)]\s+(.*)$/))) {
      push('numbered', mdToInline(m[1]!), { indent })
      continue
    }
    if ((m = t.match(/^!\[([^\]]*)\]\(([^)]*)\)(.*)$/))) {
      push('image', '', { src: m[2]!, alt: m[1]!, caption: m[3]?.trim() || undefined })
      continue
    }
    // Whole-note headings exported as **bold** are the "open" toggles we wrote out.
    push('text', mdToInline(t), { indent })
  }
  if (fence) push('code', fence.join('\n'))
  if (!blocks.length) blocks.push({ id: id(), type: 'text', content: '' })
  return blocks
}

/**
 * Reads back a folder tree produced by vaultToFiles. Markdown files are the
 * archive: notes.vault.json is deliberately ignored so a hand-edited folder
 * imports cleanly.
 */
export function treeToVault(tree: VaultTree): Vault {
  const subjects: Subject[] = []
  const topics: Topic[] = []
  const notes: Note[] = []
  let n = 0
  const mk = (p: string) => `${p}_imp${Date.now().toString(36)}${(n++).toString(36)}`
  for (const subj of tree.subjects) {
    const now = Date.now()
    const subject: Subject = {
      id: mk('s'),
      name: subj.name,
      emoji: '📚',
      color: 'graphite',
      createdAt: now,
      updatedAt: now,
    }
    subjects.push(subject)
    let order = 0
    for (const topic of subj.topics) {
      const t: Topic = {
        id: mk('t'),
        subjectId: subject.id,
        name: topic.name,
        emoji: '📄',
        order: order++,
        createdAt: now,
        updatedAt: now,
      }
      topics.push(t)
      const ordered = [...topic.notes].sort((a, b) => a.title.localeCompare(b.title))
      for (const note of ordered) {
        notes.push({
          id: mk('n'),
          topicId: t.id,
          title: note.title,
          icon: '📝',
          blocks: mdToBlocks(note.text),
          createdAt: now,
          updatedAt: now,
        })
      }
    }
  }
  return { version: 1, exportedAt: Date.now(), subjects, topics, notes }
}

export const blockPlainText = (b: Block) => (b.type === 'code' ? (b.content ?? '') : plainText(b.content ?? ''))
