import { getAiSettings, humaniseOllamaError, type AiConfig } from './ai'
import { db, digestFor, listDigests, putDigest, pageTexts, getPage } from './db'
import type { Book } from './types'

/**
 * Background studying. A local 3B model is slow at reading and fast at talking:
 * so we pay the reading cost once, per page, while the app is open, and keep a
 * short digest. Answers on a digested page start from the map instead of the raw
 * text, which is both faster (less to read) and steadier (fewer invented links).
 *
 * Nothing here ever touches the network except the local endpoint.
 */

export interface Digest {
  id: string
  bookId: string
  page: number
  at: number
  /** markdown: the 4 sections below, joined */
  md: string
  keyIdeas: string[]
  definitions: string[]
  examQuestions: string[]
  links: string[]
  /** how much page text was actually read */
  chars: number
  error?: string
}

export interface StudyState {
  running: boolean
  paused: boolean
  /** why the queue stopped by itself */
  reason?: string
  /** pages queued for the current run */
  queue: number[]
  done: number
  total: number
  current?: number
}

const PROMPT = (title: string, n: number, text: string) =>
  `Stai preparando una "scheda di studio" della pagina ${n} del libro "${title}".
Rispondi SOLO con queste 4 sezioni, in italiano, usando solo il testo dato (niente conoscenza esterna, niente invenzioni).
Ogni voce su una riga che comincia con "- ". Massimo 6 righe per sezione. Se una sezione non ha contenuto, scrivi "- –".

IDEATUTTI:
DEFINIZIONI: (termine = definizione in una riga; includi le formule se ci sono)
DOMANDE: (2-3 domande che un prof farebbe su questa pagina)
COLLEGAMENTI: (a cosa rimanda, prima o dopo, citando i numeri di pagina che vedi nel testo)

TESTO:
${text.slice(0, 5200)}`

const SECTIONS: Record<string, keyof Pick<Digest, 'keyIdeas' | 'definitions' | 'examQuestions' | 'links'>> = {
  IDEATUTTI: 'keyIdeas',
  DEFINIZIONI: 'definitions',
  DOMANDE: 'examQuestions',
  COLLEGAMENTI: 'links',
}

/** Tolerant parser: models put the labels in bold, add colons, skip sections. */
export function parseDigest(raw: string): Pick<Digest, 'keyIdeas' | 'definitions' | 'examQuestions' | 'links'> {
  const out = { keyIdeas: [] as string[], definitions: [] as string[], examQuestions: [] as string[], links: [] as string[] }
  const push = (bucket: string | null, item: string) => {
    if (!bucket) return
    const list = (out as Record<string, string[]>)[bucket]
    if (list) list.push(item)
  }
  let bucket: string | null = null
  for (const lineRaw of raw.split('\n')) {
    const line = lineRaw.trim()
    if (!line) continue
    const head = line.replace(/[*_#:`>]/g, '').trim().toUpperCase()
    // `key` is the property name on `out` ('keyIdeas'), *not* the label: do not look it up again
    const key = SECTIONS[head] ?? Object.keys(SECTIONS).find((k) => head.startsWith(k))
    if (key) {
      bucket = key
      continue
    }
    if (!bucket) continue
    const item = line.replace(/^[-*\u2022]\s*/, '').replace(/^\d+[.)]\s*/, '').trim()
    if (item && item !== '\u2013' && item !== '-' && item.length > 1) push(bucket, item)
  }
  for (const k of Object.keys(out)) {
    const list = (out as Record<string, string[]>)[k]!
    ;(out as Record<string, string[]>)[k] = [...new Set(list)].slice(0, 8)
  }
  return out
}

export function digestToMd(d: Pick<Digest, 'keyIdeas' | 'definitions' | 'examQuestions' | 'links'>, page: number) {
  const sec = (title: string, items: string[]) => (items.length ? `**${title}** (p. ${page})\n${items.map((i) => `- ${i}`).join('\n')}` : '')
  return [sec('Idee', d.keyIdeas), sec('Definizioni', d.definitions), sec('Domande', d.examQuestions), sec('Collegamenti', d.links)].filter(Boolean).join('\n\n')
}

/** The context block the AI gets when it answers about a digested page. */
export async function digestContext(bookId: string, pages: number[]): Promise<string> {
  const parts: string[] = []
  for (const n of pages) {
    const d = await digestFor(bookId, n)
    if (!d?.md.trim()) continue
    parts.push(`### scheda di studio, p. ${n}\n${d.md}`)
  }
  return parts.join('\n\n')
}

/* ------------------------------------------------------------ the worker */

type Listener = (s: StudyState) => void
let state: StudyState = { running: false, paused: false, queue: [], done: 0, total: 0 }
const listeners = new Set<Listener>()
const aborts = new Set<AbortController>()

export const studyState = () => state
export function onStudyChange(fn: Listener) {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}
const emit = (patch: Partial<StudyState>) => {
  state = { ...state, ...patch }
  for (const l of listeners) l(state)
}

let aheadDone = 0
/**
 * "Study ahead": if the user turned it on, spend a few idle minutes reading the
 * pages around the one they are on. Bounded per session so it cannot eat the day.
 */
export async function maybeStudyAhead(book: Book, page: number, config?: AiConfig) {
  const cfg = config ?? getAiSettings()
  if (!cfg.studyAhead || state.running) return
  if (aheadDone >= cfg.studyAheadBatch * 2) return
  const have = await listDigests(book.id)
  if (have.length >= Math.min(book.pageCount, 20)) return
  aheadDone += 1
  const idle = (globalThis as unknown as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void }).requestIdleCallback
  await new Promise<void>((r) => (idle ? idle(() => r(), { timeout: 4000 }) : setTimeout(r, 3000)))
  await studyBook(book, page, cfg.studyAheadBatch, cfg)
}

/**
 * Queue a page sweep around `around`: nearest pages first, `max` of them, skipping
 * pages already digested. Runs one at a time so the PC stays usable.
 */
export async function studyBook(book: Book, around = 1, max = 40, config?: AiConfig): Promise<void> {
  if (state.running) {
    emit({ paused: false, reason: undefined, queue: [...state.queue] })
    return
  }
  const cfg = config ?? getAiSettings()
  if (!cfg.model) {
    emit({ paused: true, reason: 'nessun modello locale: ollama pull qwen2.5:3b' })
    return
  }
  const texts = await pageTexts(book.id)
  const usable = texts.filter((t) => (t.text ?? '').trim().length > 120).map((t) => t.n)
  const have = new Set((await listDigests(book.id)).map((d) => d.page))
  const todo = usable
    .filter((n) => !have.has(n))
    .sort((a, b) => Math.abs(a - around) - Math.abs(b - around))
    .slice(0, max)
  if (!todo.length) {
    emit({ paused: true, reason: 'pagine già studiate (o senza testo: fai prima OCR)' })
    return
  }
  emit({ running: true, paused: false, reason: undefined, queue: todo, done: 0, total: todo.length })
  for (const page of todo) {
    if (state.paused) break
    if (await handleOffline(cfg)) break
    emit({ current: page })
    const p = await getPage(book.id, page)
    const text = (p?.text ?? '').trim()
    const ctrl = new AbortController()
    aborts.add(ctrl)
    const res = await fetchChat({
      endpoint: cfg.endpoint,
      model: cfg.model,
      text: PROMPT(book.title, page, text),
      maxTokens: 460,
      temperature: 0.15,
      signal: ctrl.signal,
      onToken: () => undefined,
    })
    aborts.delete(ctrl)
    if (res.error) {
      emit({ paused: true, reason: res.error.slice(0, 120) })
      break
    }
    if (ctrl.signal.aborted) break
    const parsed = parseDigest(res.text)
    const digest: Digest = {
      id: `d_${book.id}_${page}`,
      bookId: book.id,
      page,
      at: Date.now(),
      md: digestToMd(parsed, page),
      ...parsed,
      chars: text.length,
      ...(res.text.trim() ? {} : { error: 'risposta vuota' }),
    }
    await putDigest(digest)
    emit({ queue: state.queue.slice(1), done: state.done + 1 })
    await sleep(120) // let the browser breathe between pages
  }
  emit({ running: false, current: undefined })
}

export function stopStudy() {
  for (const c of aborts) c.abort()
  aborts.clear()
  emit({ running: false, paused: true, reason: 'fermato' })
}
export const pauseStudy = () => emit({ paused: true })

export async function dropDigests(bookId: string, page?: number) {
  if (page) {
    const d = await digestFor(bookId, page)
    if (d) await db.digests.delete(d.id)
    return
  }
  await db.digests.where('bookId').equals(bookId).delete()
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

let lastProbe = { at: 0, ok: false }
/** Cheap guard so an offline Ollama does not burn 40 failing requests. */
async function handleOffline(cfg: AiConfig): Promise<boolean> {
  if (Date.now() - lastProbe.at < 6000) return !lastProbe.ok
  try {
    const res = await fetch(`${cfg.endpoint.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(2000) })
    lastProbe = { at: Date.now(), ok: res.ok }
  } catch {
    lastProbe = { at: Date.now(), ok: false }
  }
  if (!lastProbe.ok) {
    emit({ running: false, paused: true, reason: `Ollama non risponde su ${cfg.endpoint}` })
    return true
  }
  return false
}

/** The one place that talks to the model, so the offline checks live in one spot. */
async function fetchChat(opts: {
  endpoint: string
  model: string
  text: string
  maxTokens: number
  temperature: number
  signal: AbortSignal
  onToken: (chunk: string, full: string) => void
}): Promise<{ text: string; error?: string }> {
  const base = opts.endpoint.replace(/\/$/, '')
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(base)) return { text: '', error: 'endpoint non locale' }
  let full = ''
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      signal: opts.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream: true,
        options: { temperature: opts.temperature, num_predict: opts.maxTokens, num_ctx: Math.min(16000, Math.ceil(opts.text.length / 3.6) + 800) },
        messages: [
          { role: 'system', content: 'Sei una funzione che produce schede di studio. Nessun accesso a internet. Rispondi solo col formato richiesto.' },
          { role: 'user', content: opts.text },
        ],
      }),
    })
    if (!res.ok || !res.body) return { text: '', error: humaniseOllamaError(res.status, await res.text().catch(() => ''), opts.model) }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line) as { message?: { content?: string }; error?: string }
          if (obj.error) return { text: full, error: obj.error }
          const piece = obj.message?.content ?? ''
          if (piece) {
            full += piece
            opts.onToken(piece, full)
          }
        } catch {
          /* wait for more */
        }
      }
    }
    return { text: full }
  } catch (err) {
    return { text: full, error: opts.signal.aborted ? 'interrotto' : `Ollama non risponde: ${(err as Error).message}` }
  }
}
