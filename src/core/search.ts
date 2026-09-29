/**
 * A tiny BM25 index, in-app, no dependency, no server.
 * Textbook pages are short documents with a strong title-word signal, which is
 * exactly where BM25 shines — and it needs no GPU, no model, no network.
 */

export interface Doc {
  n: number
  text: string
}

/** index-ready chunk */
export interface Chunk {
  page: number
  /** start offset into that page's text, so we can quote precisely */
  start: number
  text: string
  tokens: string[]
}

const STOP = new Set(
  `a abbi about ad agli al alla alle allo an anche and are as at avuto be been by che chi come con cui da degl degli dei del della delle dello di e ed for fra from gia giu già gli had has have i il in into is it la le li lo molto ne nel nella nello non o od of ogni on or over per piu più poche primo pure quella quello questa queste questo secondo si su sugli sui tale than that the their them then there they this those to tra troppo un una under uno was were which with`
    .split(/\s+/)
    .filter(Boolean),
)

/** Italian-first stemmer: cut the endings that change, keep the root that matters. */
/**
 * Enough Italian (and English) ending-folding to make a search over a textbook
 * behave: "funzioni" and "funzione" must meet, plurals must not hide a word.
 * Deliberately short: this is retrieval, not a linguistics degree.
 */
const SUFFIXES = [
  'amenti', 'amento', 'emente', 'azioni', 'azione', 'zioni', 'zione',
  'atore', 'atori', 'anza', 'anze', 'enza', 'enze', 'ione', 'ioni', 'ismo', 'ismi',
  'ista', 'iste', 'isti', 'isco', 'iscono', 'isce', 'iamo', 'avano',
  'eremo', 'ereste', 'ando', 'endo', 'ato', 'ata', 'ate', 'ati', 'ita', 'ite',
  'uto', 'ito', 'are', 'ere', 'ire', 'arsi', 'ersi', 'irsi',
  'oso', 'osi', 'osa', 'ose', 'ivo', 'ivi', 'iva', 'ive', 'ante', 'enti', 'enta',
  'ie', 'ia', 'io', 'i', 'e', 'a', 'o',
]

export function stem(word: string): string {
  let w = word
  if (w.length > 5) {
    for (const suf of SUFFIXES) {
      // keep at least 3 letters: 'cano' -> 'c' is useless, 'funzion' is not
      if (w.endsWith(suf) && w.length - suf.length >= 3) {
        w = w.slice(0, -suf.length)
        break
      }
    }
  } else if (w.length === 5 && /(i|e)$/.test(w)) {
    // short plurals: "cane"/"cani", "libro"/"libri" still want to meet in the middle
    w = w.slice(0, -1)
  }
  return w
}

export const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')

export function tokenize(text: string): string[] {
  return norm(text)
    .split(' ')
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem)
    .filter(Boolean)
}

export interface Hit {
  page: number
  score: number
  text: string
  start: number
}

export class Bm25 {
  private df = new Map<string, number>()
  private postings = new Map<string, Map<number, number>>()
  private lengths: number[] = []
  private chunks: Chunk[] = []
  private avg = 0
  readonly k1 = 1.4
  readonly b = 0.72

  constructor(chunks: Chunk[]) {
    this.chunks = chunks
    this.lengths = chunks.map((c) => Math.max(1, c.tokens.length))
    this.avg = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length)
    chunks.forEach((c, i) => {
      const seen = new Set<string>()
      for (const t of c.tokens) {
        if (!this.postings.has(t)) this.postings.set(t, new Map())
        this.postings.get(t)!.set(i, (this.postings.get(t)!.get(i) ?? 0) + 1)
        if (!seen.has(t)) {
          seen.add(t)
          this.df.set(t, (this.df.get(t) ?? 0) + 1)
        }
      }
    })
  }

  get size() {
    return this.chunks.length
  }

  search(query: string, limit = 12): Hit[] {
    const terms = [...new Set(tokenize(query))]
    if (!terms.length) return []
    const N = this.chunks.length
    const scores = new Map<number, number>()
    for (const term of terms) {
      const posting = this.postings.get(term)
      if (!posting) continue
      const df = this.df.get(term) ?? 1
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      for (const [i, tf] of posting) {
        const len = this.lengths[i]!
        const denom = tf + this.k1 * (1 - this.b + (this.b * len) / this.avg)
        scores.set(i, (scores.get(i) ?? 0) + idf * ((tf * (this.k1 + 1)) / denom))
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([i, score]) => ({
        page: this.chunks[i]!.page,
        score,
        text: this.chunks[i]!.text,
        start: this.chunks[i]!.start,
      }))
  }

  /** best-matching chunk per page, for building AI context without duplicates */
  bestPerPage(query: string, perPage = 3, limit = 10): Hit[] {
    const all = this.search(query, limit * 8)
    const byPage = new Map<number, number>()
    for (const h of all) {
      const c = byPage.get(h.page) ?? 0
      if (c < perPage) {
        byPage.set(h.page, c + 1)
      }
    }
    const out: Hit[] = []
    const counts = new Map<number, number>()
    for (const h of all) {
      const used = counts.get(h.page) ?? 0
      if (used >= (byPage.get(h.page) ?? 0)) continue
      counts.set(h.page, used + 1)
      out.push(h)
      if (out.length >= limit) break
    }
    return out.sort((a, b) => a.page - b.page)
  }

  /** where a phrase occurs, for highlighting */
  static snippet(text: string, query: string, radius = 170) {
    const t = norm(text)
    const terms = [...new Set(tokenize(query))].filter((w) => w.length > 2)
    let at = -1
    for (const term of terms) {
      const i = t.indexOf(term)
      if (i >= 0 && (at < 0 || i < at)) at = i
    }
    const raw = at < 0 ? text : text.slice(Math.max(0, at - 24), Math.max(0, at - 24) + radius * 2)
    return raw.trim()
  }
}

/** split a page into overlapping chunks so long pages still quote tightly */
export function chunkPage(page: number, text: string, target = 1200, overlap = 160): Chunk[] {
  const out: Chunk[] = []
  if (!text.trim()) return out
  let i = 0
  while (i < text.length) {
    let end = Math.min(text.length, i + target)
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end)
      if (nl > i + target * 0.5) end = nl
      else {
        const sp = text.lastIndexOf(' ', end)
        if (sp > i + target * 0.5) end = sp
      }
    }
    const slice = text.slice(i, end)
    if (slice.trim()) out.push({ page, start: i, text: slice, tokens: tokenize(slice) })
    if (end >= text.length) break
    i = Math.max(i + 1, end - overlap)
  }
  return out
}

export function buildIndex(pages: Doc[]): Bm25 {
  const chunks: Chunk[] = []
  for (const p of pages) chunks.push(...chunkPage(p.n, p.text ?? ''))
  return new Bm25(chunks)
}

/** The citation shape the app writes into notes and into AI prompts. */
export const citePage = (book: string, page: number) => `${book}, p. ${page}`
