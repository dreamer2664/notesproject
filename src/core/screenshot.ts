import { getAiSettings, humaniseOllamaError, type AiConfig } from './ai'
import { cleanOcr, createOcr, destroyOcr, recognize } from './import'
import type { Book } from './types'

/**
 * Screenshots in, study notes out. Nothing about the images leaves this machine:
 * the only host these prompts can ever touch is the Ollama endpoint in the config
 * (asserted in test/md.test.ts — the note-generation prompts carry no URL at all).
 *
 * Three dials the user actually cares about:
 *  - how much to think (effort),
 *  - a minimum time budget, so a quick answer is spent improving instead of ending,
 *  - whether, after all that, it may spend a few seconds looking up YouTube (off by default).
 */

export type Effort = 'veloce' | 'standard' | 'profondo'

export interface EffortPreset {
  key: Effort
  label: string
  hint: string
  /** how many screenshots we look at (0 = all of them) */
  maxImages: number
  /** images per request — small batches keep a 3B model from losing the thread */
  batchSize: number
  /** longest edge we downscale to before sending */
  maxSide: number
  /** answer length, in tokens */
  maxTokens: number
  /** extra refinement pass over the own draft */
  pass2: boolean
  /** minimum minutes the run should occupy, when auto time budget is on */
  minMinutes: number
  /** flashcards + questions pass */
  cards: boolean
  /** the YouTube lookup is even allowed */
  allowWeb: boolean
}

export const EFFORT: Record<Effort, EffortPreset> = {
  veloce: {
    key: 'veloce',
    label: 'Veloce',
    hint: 'poche immagini, una passata sola. ~1-2 min per 6 screenshot.',
    maxImages: 8,
    batchSize: 8,
    maxSide: 1100,
    maxTokens: 700,
    pass2: false,
    minMinutes: 1,
    cards: false,
    allowWeb: false,
  },
  standard: {
    key: 'standard',
    label: 'Standard',
    hint: 'tutte le immagini, 2 passate, flashcards. La scelta giusta quasi sempre.',
    maxImages: 0,
    batchSize: 6,
    maxSide: 1300,
    maxTokens: 1300,
    pass2: true,
    minMinutes: 4,
    cards: true,
    allowWeb: true,
  },
  profondo: {
    key: 'profondo',
    label: 'Profondo',
    hint: 'legge di nuovo tutto, riscrive, aggiunge esempi e domande da esame. Lento.',
    maxImages: 0,
    batchSize: 4,
    maxSide: 1500,
    maxTokens: 2200,
    pass2: true,
    minMinutes: 10,
    cards: true,
    allowWeb: true,
  },
}

/* ------------------------------------------------------------- pure bits */

/** A transcript block per screenshot: `=== 3 ===` separators, tolerant of sloppiness. */
export function splitTranscript(raw: string, count: number): string[] {
  const out = new Array<string>(count).fill('')
  const re = /^={2,}\s*(?:pagina|page|fig|img)?\s*(\d{1,3})\s*={2,}\s*$/im
  let current = 0
  let found = false
  for (const line of raw.split('\n')) {
    const m = line.match(re)
    if (m) {
      found = true
      current = Math.max(1, Math.min(count, Number(m[1]))) - 1
      continue
    }
    out[current] = out[current] ? `${out[current]}\n${line}` : line
  }
  if (!found) {
    // the model ignored the format: keep the whole text as one block so nothing is lost
    out[0] = raw.trim()
  }
  return out.map((t) => t.replace(/\n{3,}/g, '\n\n').trim())
}

const ILLEGAL_QUERY = /[^\p{L}\p{N}\s'’().,;:!?-]/u

/** Only plain search phrases survive: no URLs, no paths, no markup, no newlines. */
export function sanitiseQuery(line: string): string | null {
  let q = line
    .replace(/^\s*(?:[-*•]\s*)?(?:YT|QUERY|CERCA)\s*[:=]\s*/i, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!q || q.length > 120) return null
  if (/https?:|www\.|\.com|\.it\/|<|>|\.\.\//i.test(q)) return null
  if (ILLEGAL_QUERY.test(q)) return null
  if (q.split(' ').length < 2) return null
  if (!/[A-Za-zÀ-ÿ]{3}/.test(q)) return null
  return q
}

/**
 * The model is asked for `YT:` lines. Anything that is not one of those is
 * dropped, and the whole step is skipped unless the user ticked the box.
 */
export function extractQueries(raw: string, limit = 6): string[] {
  const out: string[] = []
  for (const line of raw.split('\n')) {
    if (!/^\s*(?:[-*•]\s*)?YT\s*:/i.test(line)) continue
    const q = sanitiseQuery(line)
    if (q && !out.some((x) => x.toLowerCase() === q.toLowerCase())) out.push(q)
    if (out.length >= limit) break
  }
  return out
}

export const ytSearchUrl = (q: string) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`

/**
 * Did we still have time? The rule the user asked for: finishing early is not
 * finished. With `auto` we stop enriching when we are past 60% of the budget,
 * so a slow PC never gets punished twice.
 */
export function shouldEnrich(opts: { elapsedMs: number; minutes: number; auto: boolean; requested: boolean }): boolean {
  if (!opts.requested) return false
  const budget = Math.max(0, opts.minutes) * 60_000
  if (budget <= 0) return opts.auto
  const left = budget - opts.elapsedMs
  if (opts.auto) return left > budget * 0.4
  return true
}

/* ------------------------------------------------------------ the engine */

export interface ScanOptions {
  /** prepared images (data URLs), in the order the user dropped them */
  images: string[]
  effort: Effort
  /** tick to let the run spend leftover time on flashcards/enrichment */
  autoTime: boolean
  /** override the minutes (0 = use the effort preset) */
  minMinutes?: number
  /** read the pixels with the model, instead of Tesseract */
  useVision: boolean
  /** keep the per-screenshot transcription in the output */
  keepTranscript: boolean
  /** after everything else: ask for YouTube searches and link them (never reads pages) */
  allowWeb: boolean
  config?: AiConfig
  model?: string
  /** the vision model to use; falls back to config.vision */
  visionModel?: string
  /** attach the notes to a book so the reader can cite pages */
  book?: Book
  fromPage?: number
  signal?: AbortSignal
  onProgress?: (p: { msg: string; done?: number; total?: number; log?: string }) => void
}

export interface ScanResult {
  notes: string
  transcript: string[]
  flashcards: string
  extras: string
  queries: string[]
  videos: { title: string; url: string }[]
  usedVision: boolean
  elapsedMs: number
  error?: string
  imageCount: number
}

const TRANSCRIBE_PROMPT = (n: number, _lang: string) =>
  `Ho ${n} immagini numerate da 1 a ${n}: pagine di libro, slide o appunti scritti a mano.
Per ognuna, trascrivi TUTTO il testo visibile (titoli, formule, didascalie, testo scritto a mano).
Non riassumere, non tradurre, non commentare. Non inventare nulla: se una parola non è leggibile scrivi [?] .
Formato esatto, immagine per immagine:

=== 1 ===
(testo trascritto)

=== 2 ===
(testo trascritto)

Lingua: la stessa dell'immagine, senza tradurre. Se devi aggiungere una nota tua, mettila fra parentesi quadre.`

const NOTES_PROMPT = (src: string, label: string) =>
  `Sei un tutor che scrive appunti per uno studente, nella sua lingua.
Scrivi appunti in Markdown, ordinati e studiabili, BASANDOTI ESCLUSIVAMENTE sul materiale qui sotto.
Regole dure:
- NON usare conoscenza esterna al materiale, NON citare fonti esterne, NON inventare nomi, date, numeri o formule che non compaiono.
- Se un passaggio è illeggibile o manca, scrivi una riga "Da chiarire: …" invece di riempire il buco.
- Struttura: un titolo, 2-4 paragrafi con i concetti, poi "Definizioni" (grassetto + una riga each), poi "Formule/procedimenti" (una per riga), poi "Esempi svolti" solo se nel materiale c'è un esempio, poi "Punti deboli / da ripassare".
- Usa capoversi corti e elenchi. Nessun preambolo, nessun "certo", nessuna scusa.
MATERALE (${label}):
${src}`

const PASS2_PROMPT = (draft: string) =>
  `Questi sono appunti grezzi scritti da te su materiale di studio. Riscrivili MEGLIO senza allungarli:
- unisci le ripetizioni, rendi espliciti i passaggi saltati, grassetto per i termini tecnici;
- aggiungi in fondo una sezione "Domande da esame" con 5 domande e, separate, le risposte brevi;
- NON aggiungere informazioni che non erano nel testo: se non è nel materiale, non deve comparire.

APPUNTI:
${draft}`

const CARDS_PROMPT = (notes: string) =>
  `Da questi appunti, ricava carte di memorizzazione. Solo formato:
DOMANDA: <una domanda secca>
RISPOSTA: <risposta di massimo 25 parole>
Massimo 12 coppie, nessuna introduzione, nessun numero.
${notes}`

const ENRICH_PROMPT = (notes: string) =>
  `Hai scritto questi appunti e c'è ancora tempo. Il tuo compito è chiederti: "cosa renderebbe lo studio di questa roba davvero più facile?"
Scegli 2 o 3 cose UTILI (non ripetere gli appunti) fra: schema a albero, tabella di confronto, "errori tipici di chi studia", mini-glossario, analogia memorabile, piano di ripasso in 3 giorni, 5 flashcard in più.
Rispondi SOLO con le sezioni scelte, in Markdown. Niente premesse.
APPUNTI:
${notes.slice(0, 7000)}`

const WEB_PROMPT = (notes: string) =>
  `Degli appunti qui sotto, individua al massimo 4 concetti che trarrebbero vantaggio da una spiegazione video di 10 minuti.
Per ognuno scrivi UNA riga in questo formato esatto, senza nient'altro:
YT: <termini di ricerca in italiano, senza URL, senza siti, senza virgolette>

APPUNTI:
${notes.slice(0, 5000)}`

const stripCode = (md: string) =>
  md
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()

/** One call to the local model. Text and/or images. Streams to `onToken`. */
export async function chat(opts: {
  model: string
  text: string
  images?: string[]
  config: AiConfig
  maxTokens: number
  temperature?: number
  topP?: number
  signal?: AbortSignal
  onToken?: (chunk: string, full: string) => void
}): Promise<{ text: string; error?: string }> {
  const base = opts.config.endpoint.replace(/\/$/, '')
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(base)) {
    return { text: '', error: `Endpoint non locale (${opts.config.endpoint}): per come è fatta quest'app l'AI può girare solo sul tuo PC.` }
  }
  const ctrl = new AbortController()
  const abort = () => ctrl.abort()
  opts.signal?.addEventListener('abort', abort)
  const contextChars = Math.round((opts.text.length + (opts.images?.length ?? 0) * 1400) / 1.2)
  let full = ''
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream: true,
        options: {
          temperature: opts.temperature ?? 0.25,
          top_p: opts.topP ?? 0.92,
          num_predict: opts.maxTokens,
          num_ctx: Math.min(32768, Math.max(4096, Math.ceil(contextChars / 3.6) + 1200)),
        },
        messages: [
          { role: 'system', content: 'Sei un assistente di studio locale. Nessun accesso a internet: usa solo il materiale fornito.' },
          { role: 'user', content: opts.text, ...(opts.images?.length ? { images: opts.images.map((d) => d.split(',')[1] ?? '') } : {}) },
        ],
      }),
    })
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      return { text: '', error: humaniseOllamaError(res.status, detail, opts.model) }
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
          const obj = JSON.parse(line) as { message?: { content?: string }; error?: string }
          if (obj.error) return { text: full, error: obj.error }
          const piece = obj.message?.content ?? ''
          if (piece) {
            full += piece
            opts.onToken?.(piece, full)
          }
        } catch {
          /* partial line, wait for the next chunk */
        }
      }
    }
    return { text: full.trim() }
  } catch (err) {
    if (ctrl.signal.aborted) return { text: full, error: full ? undefined : 'Interrotto.' }
    return { text: '', error: `Ollama non risponde: ${(err as Error).message}` }
  } finally {
    opts.signal?.removeEventListener('abort', abort)
  }
}

async function ocrAll(images: string[], onProgress?: (msg: string) => void): Promise<{ text: string[]; ok: boolean }> {
  const worker = await createOcr()
  if (!worker) return { text: images.map(() => ''), ok: false }
  const text: string[] = []
  try {
    for (const [i, img] of images.entries()) {
      onProgress?.(`OCR locale ${i + 1}/${images.length}`)
      const got = await recognize(worker, img)
      text.push(got ? cleanOcr(got) : '')
    }
  } finally {
    await destroyOcr(worker)
  }
  return { text, ok: true }
}

/** The whole thing. Kept linear and chatty so the UI can show what is happening. */
export async function runScan(opts: ScanOptions): Promise<ScanResult> {
  const config = opts.config ?? getAiSettings()
  const preset = EFFORT[opts.effort]
  const started = Date.now()
  const minutes = opts.minMinutes ?? preset.minMinutes
  const emit = (msg: string, done?: number, total?: number) => opts.onProgress?.({ msg, done, total })
  const dead = () => !!opts.signal?.aborted

  let images = opts.images
  if (preset.maxImages && images.length > preset.maxImages) {
    emit(`${images.length} immagini: con “${preset.label}” le prime ${preset.maxImages}. Passa a Standard per leggerle tutte.`)
    images = images.slice(0, preset.maxImages)
  }

  const visionModel = opts.visionModel || config.vision
  const wantsVision = opts.useVision && !!visionModel
  let transcript: string[] = []
  let usedVision = false
  let error: string | undefined

  /* 1 — read the pixels */
  if (wantsVision) {
    usedVision = true
    const batches: string[][] = []
    for (let i = 0; i < images.length; i += preset.batchSize) batches.push(images.slice(i, i + preset.batchSize))
    emit(`Leggo ${images.length} immagini con ${visionModel} (${batches.length} gruppi)…`, 0, batches.length)
    let offset = 0
    for (const [bi, batch] of batches.entries()) {
      if (dead()) break
      const res = await chat({
        model: visionModel,
        text: TRANSCRIBE_PROMPT(batch.length, config.language),
        images: batch,
        config,
        maxTokens: Math.min(2600, 420 * batch.length + 200),
        temperature: 0.1,
        topP: 0.85,
        signal: opts.signal,
      })
      if (res.error) {
        error = res.error
        break
      }
      const parts = splitTranscript(res.text, batch.length)
      for (const [k, p] of parts.entries()) transcript[offset + k] = p ?? ''
      offset += batch.length
      emit(`trascritte ${Math.min(images.length, offset)}/${images.length}`, bi + 1, batches.length)
    }
  }

  if (!usedVision || transcript.every((t) => !t.trim())) {
    if (error) emit(`visione fallita (${error.slice(0, 70)}) → passo all’OCR locale`)
    else emit('Nessun modello con visione: uso l’OCR locale (Tesseract, italiano)…')
    const ocr = await ocrAll(images, (m) => emit(m))
    if (!ocr.ok) {
      return {
        notes: '',
        transcript: [],
        flashcards: '',
        extras: '',
        queries: [],
        videos: [],
        usedVision: false,
        elapsedMs: Date.now() - started,
        error:
          'Non ho potuto leggere le immagini: serve un modello con visione (ollama pull qwen2.5vl:3b) oppure l’OCR locale, che qui non è disponibile. Le immagini sono ancora nel riquadro: puoi copiarne il testo a mano.',
        imageCount: images.length,
      }
    }
    transcript = ocr.text
    usedVision = false
    error = undefined
  }

  const joined = transcript
    .map((t, i) => `--- immagine ${i + 1}${opts.book ? ` (libro, p. ${(opts.fromPage ?? 1) + i})` : ''} ---\n${t || '(nessun testo leggibile)'}`)
    .join('\n\n')
  if (!joined.trim() || !/[a-z]{4}/i.test(joined)) {
    return {
      notes: '',
      transcript,
      flashcards: '',
      extras: '',
      queries: [],
      videos: [],
      usedVision,
      elapsedMs: Date.now() - started,
      error: 'Dalle immagini non è uscito testo sufficiente per scrivere appunti (poco contrasto, troppo piccole, o scritte a mano illeggibili). Riprova con “Profondo”, o incolla tu il testo.',
      imageCount: images.length,
    }
  }

  const model = opts.model || config.model
  if (!model) {
    return {
      notes: joined.slice(0, 8000),
      transcript,
      flashcards: '',
      extras: '',
      queries: [],
      videos: [],
      usedVision,
      elapsedMs: Date.now() - started,
      error: 'Nessun modello per gli appunti: ti lascio la trascrizione così com’è. `ollama pull qwen2.5:3b` e riparti.',
      imageCount: images.length,
    }
  }

  /* 2 — notes, only from what was read */
  emit('Scrivo gli appunti dalle immagini…')
  let draft = ''
  const first = await chat({
    model,
    text: NOTES_PROMPT(joined, usedVision ? 'trascrizione visiva delle immagini' : 'OCR delle immagini'),
    config,
    maxTokens: preset.maxTokens,
    temperature: 0.3,
    signal: opts.signal,
    onToken: (_c, full) => {
      draft = full
      opts.onProgress?.({ msg: 'appunti in scrittura…', log: full })
    },
  })
  if (first.error) return { notes: draft, transcript, flashcards: '', extras: '', queries: [], videos: [], usedVision, elapsedMs: Date.now() - started, error: first.error, imageCount: images.length }
  let notes = stripCode(first.text)

  /* 3 — the refinement pass, which is where "profondo" earns its time */
  if (preset.pass2) {
    emit('Seconda passata: riordino, domande da esame…')
    const second = await chat({ model, text: PASS2_PROMPT(notes), config, maxTokens: Math.round(preset.maxTokens * 0.8), temperature: 0.25, signal: opts.signal, onToken: (_c, full) => opts.onProgress?.({ msg: 'seconda passata…', log: full }) })
    if (!second.error && second.text.length > notes.length * 0.5) notes = stripCode(second.text)
  }

  /* 4 — leftover time is not idle time */
  let extras = ''
  let flashcards = ''
  const elapsed = () => Date.now() - started
  if (preset.cards && shouldEnrich({ elapsedMs: elapsed(), minutes, auto: opts.autoTime, requested: true })) {
    emit('Tempo avanzato: flashcard…')
    const c = await chat({ model, text: CARDS_PROMPT(notes), config, maxTokens: 700, temperature: 0.2, signal: opts.signal })
    if (!c.error) flashcards = c.text
  }
  if (shouldEnrich({ elapsedMs: elapsed(), minutes, auto: opts.autoTime, requested: preset.pass2 })) {
    emit('Cosa altro servirebbe?')
    const e = await chat({ model, text: ENRICH_PROMPT(notes), config, maxTokens: 800, temperature: 0.55, topP: 0.95, signal: opts.signal })
    if (!e.error) extras = e.text
  }

  /* 5 — the only optional network step, opt-in, and it never reads pages */
  const queries: string[] = []
  const videos: { title: string; url: string }[] = []
  if (opts.allowWeb && preset.allowWeb) {
    emit('Chiedo al modello cosa varrebbe la pena vedere in video…')
    const w = await chat({ model, text: WEB_PROMPT(notes), config, maxTokens: 220, temperature: 0.4, signal: opts.signal })
    queries.push(...extractQueries(w.text))
    if (queries.length) {
      emit(`${queries.length} ricerche su YouTube (solo il link, nessuna pagina letta)…`)
      for (const q of queries) {
        if (dead()) break
        videos.push({ title: q, url: ytSearchUrl(q) })
      }
    }
  }

  if (dead()) emit('Interrotto: quello che c’è già qui resta salvato.')

  return {
    notes,
    transcript: opts.keepTranscript ? transcript : [],
    flashcards,
    extras,
    queries,
    videos,
    usedVision,
    elapsedMs: elapsed(),
    imageCount: images.length,
  }
}

/** Screenshot -> data URL at the size the effort dial allows, white background. */
export async function prepareForScan(file: File, maxSide: number, quality = 0.9): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return await new Promise<string>((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result))
    fr.onerror = () => rej(new Error(`lettura di ${file.name} fallita`))
    fr.readAsDataURL(file)
  })
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas.toDataURL()
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  return canvas.toDataURL('image/jpeg', quality)
}

export const fmtElapsed = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
