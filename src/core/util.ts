/** Small helpers used everywhere. No dependencies. */

let counter = 0

/** Sortable, readable, collision-free enough for a single-device app. */
export function uid(prefix = 'x'): string {
  counter = (counter + 1) % 1296
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}${Math.random()
    .toString(36)
    .slice(2, 6)}`
}

export const debounce = <A extends unknown[]>(fn: (...args: A) => void, ms = 600) => {
  let t: number | undefined
  return (...args: A) => {
    if (t !== undefined) clearTimeout(t)
    t = setTimeout(() => fn(...args), ms) as unknown as number
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Strips anything that could execute from pasted/loaded content.
 * We only ever allow a handful of inline tags inside note text.
 */
export function sanitizeHtml(html: string): string {
  const allowed = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'CODE', 'BR', 'A', 'SPAN'])
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (!allowed.has(child.tagName)) {
        // keep the text, drop the container
        child.replaceWith(document.createTextNode(child.textContent ?? ''))
        continue
      }
      for (const attr of Array.from(child.attributes)) {
        const keep = child.tagName === 'A' && attr.name === 'href'
        if (!keep) child.removeAttribute(attr.name)
      }
      if (child.tagName === 'A') {
        const href = child.getAttribute('href') ?? ''
        if (!/^https?:/i.test(href)) child.removeAttribute('href')
        else {
          child.setAttribute('target', '_blank')
          child.setAttribute('rel', 'noopener noreferrer')
        }
      }
      walk(child)
    }
    return node.innerHTML
  }
  return walk(doc.body)
}

/** Keep only tags that survive as note formatting, used when pasting rich text. */
export function stripToInline(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = sanitizeHtml(html)
  return div.innerHTML.trim()
}

/** DOM-free html -> text, so previews and tests work without a browser. */
export function htmlToText(html: string): string {
  return (html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:div|p|li|h[1-6]|blockquote|pre)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

export function plainText(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html.replace(/<br\s*\/?>/gi, '\n')
  return (div.textContent ?? '').replace(/\u00a0/g, ' ')
}

export function safeUrl(url: string): string {
  const t = (url ?? '').trim()
  return /^https?:\/\//i.test(t) ? t : t ? `https://${t}` : ''
}

export function hostOf(url: string): string {
  try {
    return new URL(safeUrl(url)).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export const fmtDate = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export function fmtRelative(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d ago`
  return fmtDate(ts)
}

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** Word count for the note footer. */
export function wordCount(html: string): number {
  const t = plainText(html).trim()
  return t ? t.split(/\s+/).length : 0
}

/** Highlight the matching part of a title in search results. */
export function mark(text: string, query: string): string {
  const i = text.toLowerCase().indexOf(query.toLowerCase())
  if (i < 0 || !query) return escapeHtml(text)
  return (
    escapeHtml(text.slice(0, i)) +
    `<mark>${escapeHtml(text.slice(i, i + query.length))}</mark>` +
    escapeHtml(text.slice(i + query.length))
  )
}

/**
 * Which `Event` class to build depends on who is listening: a DOM node wants the
 * window's Event, while jsdom's plain `new EventTarget()` is Node's own and rejects
 * DOM events (and vice versa). Picking the constructor from the target keeps
 * App.emit() working in the browser and under the smoke test.
 */
export function domEvent(type: string, target?: EventTarget): Event {
  const g = globalThis as unknown as { window?: { Event?: typeof Event }; Event?: typeof Event }
  const owner = (target?.constructor as unknown as { Event?: typeof Event } | undefined) ?? undefined
  const Ctor = owner?.Event ?? g.window?.Event ?? g.Event
  return Ctor ? new Ctor(type) : ({ type } as Event)
}
