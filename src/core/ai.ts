import { getPage, pageTexts } from './db'
import { Bm25, buildIndex, citePage } from './search'
import type { Book } from './types'

/**
 * The AI, with no API key and no cloud.
 *
 * It talks to Ollama on the user's own machine (http://127.0.0.1:11434). Ollama
 * allows requests from localhost origins by default, so running the app from
 * `npm run dev` needs zero configuration. If no model is loaded, retrieval mode
 * still answers honestly by quoting the book.
 */

export interface AiConfig {
  endpoint: string
  model: string
  vision: string
  useVision: boolean
  /** answer language for the model */
  language: 'italiano' | 'english'
  /** rough character budget for retrieved context */
  contextChars: number
  temperature: number
}

export const DEFAULT_AI: AiConfig = {
  endpoint: 'http://127.0.0.1:11434',
  model: '',
  vision: '',
  useVision: false,
  language: 'italiano',
  contextChars: 9000,
  temperature: 0.2,
}

/** Settings live in localStorage: available before the DB opens, no async dance. */
const AI_KEY = 'notes.ai.v1'
export function getAiSettings(): AiConfig {
  try {
    const raw = localStorage.getItem(AI_KEY)
    if (raw) return { ...DEFAULT_AI, ...(JSON.parse(raw) as Partial<AiConfig>) }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_AI }
}
export async function setAiSettings(patch: Partial<AiConfig>): Promise<AiConfig> {
  const next = { ...getAiSettings(), ...patch }
  try {
    localStorage.setItem(AI_KEY, JSON.stringify(next))
  } catch {
    /* private mode: keep it in memory anyway */
  }
  return next
}

export type OllamaState = {
  status: 'ok' | 'offline' | 'cors' | 'error'
  models: string[]
  /** models Ollama reports as vision-capable, when the version exposes it */
  visionModels: string[]
  version?: string
  detail?: string
}

const controller = new Map<string, AbortController>()

export async function checkOllama(endpoint: string, signal?: AbortSignal): Promise<OllamaState> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 2200)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort)
  if (typeof fetch !== 'function') return { status: 'offline', models: [], visionModels: [], detail: 'no fetch' }
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/api/tags`, { signal: ctrl.signal })
    if (!res.ok) return { status: 'error', models: [], visionModels: [], detail: `HTTP ${res.status}` }
    const json = (await res.json()) as { models?: { name: string; details?: { family?: string }; capabilities?: string[] }[]; version?: string }
    const models = (json.models ?? []).map((m) => m.name)
    const visionModels = (json.models ?? [])
      .filter((m) => (m.capabilities ?? []).includes('vision') || /vision|vl|llava|moondream|minicpm|gemma3:4b|gemma3:12b/i.test(m.name))
      .map((m) => m.name)
    return { status: 'ok', models, visionModels, version: json.version }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    const aborted = /abort/i.test(msg)
    return {
      status: aborted ? 'cors' : 'offline',
      models: [],
      visionModels: [],
      detail: aborted ? 'richiesta bloccata (CORS o server occupato)' : 'nessuna risposta — Ollama non è in esecuzione?',
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/* ------------------------------------------------------------ prompt build */

export interface AskOptions {
  config: AiConfig
  book?: Book
  /** the page the reader is on; ±1 neighbour pages are included */
  page?: number
  /** optional image (data URL) to send to a vision model */
  image?: string
  /** override the retrieved context with a fixed passage, e.g. a selection */
  passage?: string
  index?: Bm25
  /** "Spiega", "Riassumi", ... a short instruction that shapes the prompt */
  task?: string
  onToken?: (chunk: string, full: string) => void
}

export interface AskResult {
  text: string
  /** passages actually used, rendered as citations */
  sources: { page: number; text: string }[]
  mode: 'model' | 'retrieval'
  error?: string
}

export const TASKS: { key: string; label: string; prompt: string }[] = [
  { key: 'spiega', label: 'Spiega questa pagina', prompt: 'Spiega in modo chiaro e ordinato il contenuto della pagina, come farebbe un buon insegnante: concetto centrale, passaggi, un esempio concreto.' },
  { key: 'semplifica', label: 'Semplifica', prompt: 'Riscrivi il passaggio più difficile di questa pagina in italiano semplice, senza perdere il significato tecnico. Evidenzia i termini importanti in grassetto.' },
  { key: 'riassumi', label: 'Riassumi', prompt: "Elenca in 4-7 punti il succo della pagina. Ogni punto deve contenere un numero di pagina tra parentesi." },
  { key: 'definizioni', label: 'Definizioni e teoremi', prompt: 'Estrai definizioni, teoremi e formule importanti, ciascuno con il numero di pagina e, se utile, la formula riscritta su una riga.' },
  { key: 'domande', label: 'Domande di ripasso', prompt: 'Scrivi 6 domande di verifica sul contenuto (risposte separate, alla fine), prendendo solo informazioni presenti nel testo.' },
  { key: 'figure', label: 'Descrivi figura / grafico', prompt: "Descrivi che cosa mostrano figure e grafici della pagina e che relazione hanno con il testo. Se non c'è nessuna figura da leggere, dillo." },
  { key: 'collega', label: 'Collega agli appunti', prompt: "Indica come il contenuto della pagina si collega a un capitolo precedente o a un concetto già introdotto, citando le pagine." },
]

const systemPrompt = (c: AiConfig) =>
  [
    'Sei un assistente di studio integrato in un app di appunti. Rispondi SOLO in base alle pagine di libro fornite nel contesto.',
    `Lingua della risposta: ${c.language}.`,
    'Cita sempre la pagina tra parentesi nel formato (p. N) quando usi un fatto del contesto.',
    'Se la risposta non è nel contesto, dillo in una riga e, solo se utile, aggiungila separata con "Fuori dal testo:".',
    'Niente premesse e niente riassunto della domanda. Usa elenchi e grassetti dove aiuta. Sii preciso sui termini tecnici.',
    'Se il contesto è in un\'altra lingua, rispondi comunque nella lingua richiesta tradurrendo i termini correttamente.',
  ].join(' ')

const charsPerToken = 3.6

export function fitChunks(chunks: { page: number; text: string; score: number }[], budget: number) {
  const out: { page: number; text: string }[] = []
  let used = 0
  for (const c of chunks) {
    const body = c.text.length > 1400 ? `${c.text.slice(0, 1400)}…` : c.text
    if (used + body.length > budget && out.length >= 2) break
    out.push({ page: c.page, text: body })
    used += body.length
  }
  return out
}

export async function buildContext(
  book: Book | undefined,
  page: number | undefined,
  question: string,
  config: AiConfig,
  index?: Bm25,
): Promise<{ context: string; sources: { page: number; text: string }[]; idx: Bm25 | null }> {
  if (!book) return { context: '', sources: [], idx: null }
  let idx = index
  if (!idx) {
    const pages = await pageTexts(book.id)
    idx = buildIndex(pages)
    indexCache.set(book.id, { at: Date.now(), index: idx })
  }
  const parts: string[] = []
  const used = new Set<number>()

  // the open page is the primary source of truth
  if (page) {
    for (const n of [page - 1, page, page + 1]) {
      if (n < 1 || n > book.pageCount) continue
      const p = await getPage(book.id, n)
      const text = (p?.text ?? '').trim()
      if (!text) continue
      used.add(n)
      parts.push(`### p. ${n}\n${text.slice(0, 3800)}`)
    }
  }

  const budget = Math.max(2400, config.contextChars)
  let retrieved: { page: number; text: string }[] = []
  if (question.trim()) {
    const hits = idx.bestPerPage(question, 3, 14).filter((h) => !used.has(h.page))
    retrieved = fitChunks(
      hits.map((h) => ({ page: h.page, text: h.text, score: h.score })),
      Math.max(0, budget - parts.join('\n\n').length),
    )
  }
  const all = [
    ...(used.size ? [`## Pagina aperta (${book.title})\n\n${parts.join('\n\n')}`] : []),
    ...(retrieved.length
      ? [`## Brani rilevanti dal resto del libro\n\n${retrieved.map((r) => `### p. ${r.page}\n${r.text}`).join('\n\n')}`]
      : []),
  ]
  return { context: all.join('\n\n'), sources: [...parts.map((_, i) => ({ page: [...used][i]!, text: '' })), ...retrieved], idx }
}

const indexCache = new Map<string, { at: number; index: Bm25 }>()
export const cachedIndex = (bookId: string) => indexCache.get(bookId)?.index
export const dropIndex = (bookId: string) => indexCache.delete(bookId)

/* ------------------------------------------------------------- the call */

export async function ask(question: string, opts: AskOptions): Promise<AskResult> {
  const { config, book, page, image, task, onToken, index } = opts
  const instruction = TASKS.find((t) => t.key === task)?.prompt ?? ''

  const built = await buildContext(book, page, question, config, index)
  let context = built.context
  if (opts.passage) context = `## Passaggio selezionato\n${opts.passage}\n\n${context}`

  const sources = built.sources.filter((s) => s.text).length
    ? built.sources.filter((s) => s.text)
    : context
        ? [...context.matchAll(/^### p\. (\d+)$/gm)].map((m) => ({ page: Number(m[1]), text: '' }))
        : []

  // No model configured/available -> honest retrieval answer instead of pretending.
  if (!config.model) {
    return { text: retrievalAnswer(question, context, book), sources: sources.map((s) => ({ page: s.page, text: s.text })), mode: 'retrieval' }
  }

  const wantsImage = !!image && config.useVision && !!config.vision
  const userText = [
    question.trim() || instruction,
    instruction && question.trim() ? instruction : '',
    context ? `\n--- CONTESTO (pagine del libro "${book?.title ?? ''}") ---\n${context}\n--- FINE CONTESTO ---` : '\n(Nessun contesto: il libro non è stato importato o non ha testo.)',
  ]
    .filter(Boolean)
    .join('\n')

  const messages = [
    { role: 'system', content: systemPrompt(config) },
    { role: 'user', content: userText, ...(wantsImage ? { images: [image!.split(',')[1] ?? ''] } : {}) },
  ]

  const id = `${Date.now()}`
  const ctrl = new AbortController()
  controller.set(id, ctrl)
  const model = wantsImage ? config.vision : config.model
  const maxTokens = Math.min(1400, Math.max(240, Math.round((question.length + 600) / 2)))

  let full = ''
  try {
    const res = await fetch(`${config.endpoint.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        options: { temperature: config.temperature, num_predict: maxTokens, num_ctx: Math.min(16000, Math.ceil((context.length + userText.length) / charsPerToken) + 900) },
        messages,
      }),
    })
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      return {
        text: '',
        sources: [],
        mode: 'model',
        error: humaniseOllamaError(res.status, detail, model),
      }
    }
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
          const obj = JSON.parse(line) as { message?: { content?: string }; error?: string; done?: boolean }
          if (obj.error) return { text: full, sources: [], mode: 'model', error: obj.error }
          const piece = obj.message?.content ?? ''
          if (piece) {
            full += piece
            onToken?.(piece, full)
          }
        } catch {
          /* partial JSON line: wait for the next chunk */
        }
      }
    }
    return { text: full.trim(), sources: sources.map((s) => ({ page: s.page, text: s.text })), mode: 'model' }
  } catch (err) {
    const aborted = ctrl.signal.aborted
    if (aborted && full) return { text: full, sources: [], mode: 'model' }
    return {
      text: '',
      sources: [],
      mode: 'retrieval',
      error: aborted ? 'Interrotto.' : `Ollama non risponde: ${(err as Error).message}. Controlla che "ollama serve" sia attivo su ${config.endpoint}.`,
    }
  } finally {
    controller.delete(id)
  }
}

export const stopAll = () => {
  for (const c of controller.values()) c.abort()
  controller.clear()
}

function humaniseOllamaError(status: number, detail: string, model: string) {
  const d = detail.toLowerCase()
  if (status === 404 || d.includes('not found')) return `Modello "${model}" non installato: lancia  ollama pull ${model}`
  if (d.includes('no space')) return ' Disco pieno: Ollama non ha spazio per caricare il modello.'
  if (d.includes('overflow') || d.includes('context length')) return 'Contesto troppo lungo per questo modello: riduci i caratteri recuperati nelle impostazioni AI.'
  if (status === 500) return `Il modello ha fallito (${detail.slice(0, 160)})`
  return `Ollama ha risposto ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
}

/** Shown when there is no local model: real quotes, no invented prose. */
function retrievalAnswer(question: string, context: string, book?: Book) {
  if (!context) {
    return book
      ? `Nessun testo da citare in "${book.title}". Il libro è stato importato senza estrazione del testo (scansione pura): riimportalo con OCR attivo, oppure incolla il testo delle pagine.`
      : 'Nessun libro importato: apri un libro per cercare al suo interno.'
  }
  const blocks = context
    .split(/\n### p\. /)
    .slice(1)
    .map((b) => {
      const nl = b.indexOf('\n')
      const page = Number(b.slice(0, nl).trim())
      const text = b.slice(nl + 1).trim()
      return { page, text }
    })
    .filter((b) => b.text.length > 30)
  const picked = blocks.slice(0, 6)
  const q = question.trim()
  const head = q
    ? `Nessun modello locale caricato, quindi non rispondo io: ecco i punti del libro che corrispondono a «${q}».`
    : 'Nessun modello locale caricato: ecco la pagina, nuda e cruda.'
  return [
    head,
    '',
    ...picked.map((b) => `**${citePage(book?.title ?? 'libro', b.page)}**\n> ${b.text.slice(0, 700).replace(/\n+/g, ' ')}`),
    '',
    '_Per risposte elaborate: `ollama pull qwen2.5:3b` (8 GB di RAM) e poi selezionalo in Impostazioni → AI._',
  ].join('\n')
}

/* ------------------------------------------------------ tiny markdown */

/** Escape just enough for the note view; the reader owns its own rendering. */
export function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const lines = esc(md).split('\n')
  const out: string[] = []
  let inList = false
  const inline = (s: string) =>
    s
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[(\d+)\]\(#\)/g, '<a href="#" data-page="$1">p. $1</a>')
      .replace(/\(p\. (\d+)\)/g, ' <a href="#" class="cite" data-page="$1">(p. $1)</a>')
  for (const line of lines) {
    if (/^\s*[-•]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inline(line.replace(/^\s*[-•]\s+/, ''))}</li>`)
      continue
    }
    if (inList) {
      out.push('</ul>')
      inList = false
    }
    if (/^#{1,3}\s+/.test(line)) out.push(`<h4>${inline(line.replace(/^#{1,3}\s+/, ''))}</h4>`)
    else if (/^\s*>\s?/.test(line)) out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`)
    else if (/^\s*\d+\.\s+/.test(line)) out.push(`<p class="num">${inline(line)}</p>`)
    else if (!line.trim()) out.push('')
    else out.push(`<p>${inline(line)}</p>`)
  }
  if (inList) out.push('</ul>')
  return out.join('\n')
}

export const estimateTokens = (s: string) => Math.round(s.length / charsPerToken)
