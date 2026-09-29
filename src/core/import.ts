import type { Book, Page } from './types'
import { fileToImageSrc } from './fs'
import { uid } from './util'

/**
 * Getting a whole textbook into the app, in the browser, with no installer and no API.
 *
 * Four doors, in order of how good the result is:
 *   .epub  -> real text layer (the "libro liquido" and the myZanichelli download are EPUBs)
 *   .pdf   -> text layer when the PDF has one, page renders when it does not
 *   folder/zip of page images -> text via local OCR (tesseract WASM, shipped in the build)
 *   nothing at all             -> create a book of blanks and paste text in page by page
 *
 * Nothing here talks to a publisher's servers. It reads files you already have.
 */

export interface Progress {
  (msg: string, done?: number, total?: number): void
}

export interface ImageFile {
  name: string
  blob: Blob
}

export interface ImportOptions {
  /** EPUB: how many extracted lines make one virtual page */
  epubLinesPerPage?: number
  title?: string
  author?: string
  subjectId?: string
  /** longest edge of stored page images */
  maxSide?: number
  quality?: number
  /** run OCR on pages that have no text layer (images only) */
  ocr?: boolean
  ocrLimit?: number
  /** keep page images at all; false = text-only book, ~free storage */
  keepImages?: boolean
  onProgress?: Progress
}

export interface ImportedBook {
  book: Book
  pages: Page[]
  warnings: string[]
}

const EPP = 3_000_000
const EP_MAGIC = 0x0808b615

/* ============================================================ page images */

const naturalKey = (name: string) => {
  const digits = name.replace(/\.[a-z]+$/i, '').match(/(\d+)/g)
  return digits ? Number(digits[digits.length - 1]) : Number.MAX_SAFE_INTEGER
}

export const sortPageFiles = <T extends { name: string }>(files: T[]): T[] =>
  [...files].sort((a, b) => {
    const ka = naturalKey(a.name)
    const kb = naturalKey(b.name)
    return ka === kb ? a.name.localeCompare(b.name, undefined, { numeric: true }) : ka - kb
  })

/** Does this set look like one image per page, in order? */
export function looksLikePages(files: { name: string }[]) {
  const imgs = files.filter((f) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name))
  if (imgs.length < 4) return false
  const numbers = imgs.map((f) => naturalKey(f.name)).filter((n) => Number.isFinite(n))
  if (numbers.length < imgs.length * 0.8) return false
  const sorted = [...numbers].sort((a, b) => a - b)
  const gaps = sorted.filter((v, i) => i > 0 && v - sorted[i - 1]! > 1).length
  return gaps <= Math.max(1, Math.floor(sorted.length * 0.1))
}

export async function importImages(
  files: ImageFile[],
  opts: ImportOptions = {},
): Promise<ImportedBook> {
  const warn: string[] = []
  const imgs = sortPageFiles(files.filter((f) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name)))
  const maxSide = opts.maxSide ?? 1500
  const quality = opts.quality ?? 0.78
  const keepImages = opts.keepImages !== false
  const pages: Page[] = []
  let ocrRun = 0
  const ocrLimit = opts.ocrLimit ?? 250
  let ocr = opts.ocr ? await createOcr().catch(() => null) : null
  if (opts.ocr && !ocr) warn.push('OCR engine not available here — pages were imported as images only.')

  for (let i = 0; i < imgs.length; i++) {
    const f = imgs[i]!
    opts.onProgress?.(`Pagina ${i + 1}/${imgs.length}`, i + 1, imgs.length)
    let image: string | undefined
    let imageW: number | undefined
    let imageH: number | undefined
    if (keepImages) {
      try {
        image = await fileToImageSrc(f.blob as unknown as File, maxSide, quality)
        const size = await measureDataUrl(image)
        imageW = size?.w
        imageH = size?.h
      } catch {
        warn.push(`${f.name}: could not be read`)
      }
    }
    let text = ''
    let kind: Page['ocr'] = 'none'
    if (ocr && ocrRun < ocrLimit && image) {
      const got = await recognize(ocr, image)
      ocrRun++
      if (got) {
        text = got
        kind = 'ocr'
      }
    }
    pages.push({ id: uid('p'), bookId: '', n: i + 1, text, image, imageW, imageH, ocr: kind })
  }
  if (ocr) await destroyOcr(ocr)

  const withText = pages.filter((p) => p.text.trim().length > 20).length
  const book: Book = {
    id: uid('k'),
    title: opts.title?.trim() || titleFromFiles(imgs.map((f) => f.name)) || 'Page images',
    author: opts.author,
    subjectId: opts.subjectId,
    pageCount: pages.length,
    origin: 'images',
    quality: `${maxSide}px / q${quality}`,
    textCoverage: pages.length ? withText / pages.length : 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  for (const p of pages) p.bookId = book.id
  return { book, pages, warnings: warn }
}

const titleFromFiles = (names: string[]) => {
  const dirs = names.map((n) => n.split('/')[0]).filter((d, i, a) => d && d !== names[i + 1]?.split('/')[0] && a.indexOf(d) === i)
  return dirs.length === 1 && dirs[0]!.length > 3 ? dirs[0]!.replace(/[-_]+/g, ' ') : ''
}

/* ============================================================ EPUB (zip) */

async function inflate(buf: Uint8Array, method: number): Promise<Uint8Array> {
  const format = method === 8 ? 'deflate-raw' : method === 0 ? 'deflate' : null
  if (!format) throw new Error(`zip method ${method} unsupported`)
  try {
    return await pipe(new DecompressionStream(format), buf)
  } catch {
    if (format === 'deflate-raw') return pipe(new DecompressionStream('deflate'), padZero(buf))
    throw new Error('decompression failed')
  }
}
const padZero = (b: Uint8Array) => {
  const out = new Uint8Array(b.length + 2)
  out.set(b)
  out[0] = 0x78
  out[1] = 0x9c
  out.set(b, 2)
  return out
}
const pipe = async (stream: DecompressionStream, data: Uint8Array) => {
  const buf = await new Response(new Blob([data as unknown as BlobPart]).stream().pipeThrough(stream)).arrayBuffer()
  return new Uint8Array(buf)
}

export async function readZip(buf: ArrayBuffer) {
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  let eocd = -1
  const from = Math.max(0, view.byteLength - EPP)
  for (let i = view.byteLength - 22; i >= from; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory)')
  let cd = view.getUint32(eocd + 16, true)
  const count = view.getUint16(eocd + 10, true)
  const zip64 = cd === 0xffffffff
  if (zip64) {
    let loc = -1
    for (let i = eocd - 20; i >= from; i--) {
      if (view.getUint32(i, true) === 0x07064b50) {
        loc = i
        break
      }
    }
    if (loc >= 0) {
      const offView = new DataView(buf, loc + 12, 8)
      cd = Number(offView.getBigUint64(0, true))
    }
  }
  const files = new Map<string, { method: number; comp: number; uncomp: number; offset: number }>()
  let p = cd
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break
    const method = view.getUint16(p + 10, true)
    const compSize = view.getUint32(p + 20, true)
    const uncompSize = view.getUint32(p + 24, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const local = view.getUint32(p + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen))
    let size = compSize
    if (size === 0xffffffff) {
      const extra = bytes.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
      const dv = new DataView(extra.buffer, extra.byteOffset, extra.byteLength)
      for (let e = 0; e + 4 <= dv.byteLength; ) {
        const id = dv.getUint16(e, true)
        const sz = dv.getUint16(e + 2, true)
        if (id === 0x0001 && uncompSize === 0xffffffff) {
          size = Number(dv.getBigUint64(e + 12, true))
          break
        }
        e += 4 + sz
      }
    }
    if (!name.endsWith('/')) files.set(name, { method, comp: size, uncomp: uncompSize, offset: local })
    p += 46 + nameLen + extraLen + commentLen
  }
  return {
    names: () => [...files.keys()],
    async read(name: string): Promise<Uint8Array | null> {
      const f = files.get(name)
      if (!f) return null
      let lh = f.offset
      if (view.getUint32(lh, true) !== 0x04034b50) {
        // zip64/extra field drift: search forward for the next local header
        lh = findLocalHeader(view, bytes, f.offset, name)
      }
      const nameLen = view.getUint16(lh + 26, true)
      const extraLen = view.getUint16(lh + 28, true)
      const start = lh + 30 + nameLen + extraLen
      const raw = bytes.subarray(start, start + f.comp)
      if (f.method === 0) return raw
      // encrypted? (EPUBs with DRM set bit 0)
      if ((view.getUint16(lh + 6, true) & 1) === 1) throw new Error(`"${name}" is encrypted (DRM) — this importer needs a DRM-free file`)
      return inflate(raw, f.method)
    },
  }
}

function findLocalHeader(view: DataView, bytes: Uint8Array, at: number, name: string) {
  const dec = new TextDecoder()
  for (let i = Math.max(0, at - 4); i < Math.min(bytes.length - 4, at + 300); i++) {
    if (view.getUint32(i, true) === 0x04034b50) {
      const nl = view.getUint16(i + 26, true)
      if (dec.decode(bytes.subarray(i + 30, i + 30 + nl)) === name) return i
    }
  }
  return at
}

const utf8 = (b: Uint8Array) => new TextDecoder('utf-8').decode(b)

export async function parseEpub(buf: ArrayBuffer, opts: ImportOptions = {}): Promise<ImportedBook> {
  const zip = await readZip(buf)
  const warn: string[] = []
  const containerRaw = await zip.read('META-INF/container.xml')
  if (!containerRaw) throw new Error('META-INF/container.xml missing — not a valid EPUB')
  const rootfile = new DOMParser()
    .parseFromString(utf8(containerRaw), 'application/xml')
    .querySelector('rootfile')
    ?.getAttribute('full-path')
  if (!rootfile) throw new Error('no rootfile in container.xml')
  const opfRaw = await zip.read(rootfile)
  if (!opfRaw) throw new Error(`package document "${rootfile}" not found`)
  const opf = new DOMParser().parseFromString(utf8(opfRaw), 'application/xml')
  const base = rootfile.includes('/') ? rootfile.slice(0, rootfile.lastIndexOf('/') + 1) : ''
  const manifest = new Map<string, string>()
  const mime = new Map<string, string>()
  for (const item of Array.from(opf.querySelectorAll('manifest > item'))) {
    const id = item.getAttribute('id')
    const href = item.getAttribute('href')
    if (id && href) {
      manifest.set(id, normalisePath(base, decodeURIComponent(href)))
      mime.set(id, item.getAttribute('media-type') ?? '')
    }
  }
  const spineIds = Array.from(opf.querySelectorAll('spine > itemref'))
    .map((r) => r.getAttribute('idref'))
    .filter((x): x is string => !!x)
  const titles = Array.from(opf.getElementsByTagName('dc:title')).map((n) => n.textContent?.trim() ?? '')
  const authors = Array.from(opf.getElementsByTagName('dc:creator')).map((n) => n.textContent?.trim() ?? '')

  const pages: Page[] = []
  const perPage = opts.epubLinesPerPage ?? 44
  for (const id of spineIds) {
    const path = manifest.get(id)
    if (!path || !/\.x?html?$/i.test(path)) continue
    const raw = await zip.read(path)
    if (!raw) continue
    const doc = new DOMParser().parseFromString(utf8(raw), 'text/html')
    doc.querySelectorAll('script,style,head,svg:not(image)').forEach((n) => n.remove())
    const lines = blockLines(doc)
    for (let i = 0; i < lines.length; i += perPage) {
      const chunk = lines.slice(i, i + perPage).join('\n')
      if (!chunk.trim()) continue
      pages.push({
        id: uid('p'),
        bookId: '',
        n: pages.length + 1,
        text: chunk,
        ocr: 'text',
        image: undefined,
      })
    }
  }
  if (!pages.length) warn.push('EPUB parsed but no readable text was found (it may be image-only or use an odd spine).')

  const book: Book = {
    id: uid('k'),
    title: opts.title?.trim() || titles[0] || 'EPUB',
    author: opts.author?.trim() || authors[0],
    subjectId: opts.subjectId,
    pageCount: pages.length,
    origin: 'epub',
    textCoverage: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  for (const p of pages) p.bookId = book.id
  void mime
  return { book, pages, warnings: warn }
}

/** block-level text extraction, keeping heading/list structure as markdown-ish lines */
function blockLines(doc: Document): string[] {
  const out: string[] = []
  const emit = (prefix: string, node: Element) => {
    const text = (node.textContent ?? '').replace(/\u00ad/g, '').replace(/[ \t]+/g, ' ').trim()
    if (text) out.push(prefix + text)
  }
  const walk = (parent: Element) => {
    for (const node of Array.from(parent.children)) {
      const tag = node.tagName.toUpperCase()
      if (/^H[1-6]$/.test(tag)) emit('#'.repeat(Math.min(3, Number(tag[1]))) + ' ', node)
      else if (tag === 'UL' || tag === 'OL') {
        let i = 1
        for (const li of Array.from(node.children)) {
          emit(`${tag === 'OL' ? `${i++}. ` : '- '}`, li)
        }
      } else if (tag === 'BLOCKQUOTE') emit('> ', node)
      else if (tag === 'IMG' || tag === 'SVG' || tag === 'FIGURE') {
        const alt = node.getAttribute('alt') ?? node.querySelector('img')?.getAttribute('alt') ?? ''
        if (alt.trim()) out.push(`[figura: ${alt.trim()}]`)
      } else if (node.children.length && !/P|DIV|LI|TD|TH|SPAN/.test(tag)) walk(node)
      else if (node.querySelector?.('p, li, h1, h2, h3, table')) walk(node)
      else emit('', node)
    }
  }
  const root = doc.querySelector('body') ?? doc.documentElement
  walk(root)
  return out
}

const normalisePath = (base: string, href: string) => {
  const stack = (base + href).split('/')
  const out: string[] = []
  for (const part of stack) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/* ============================================================ PDF */

let pdfjsPromise: Promise<Awaited<typeof import('pdfjs-dist')>> | null = null
const loadPdfjs = async () => {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then(async (mod) => {
      const Worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
      mod.GlobalWorkerOptions.workerSrc = Worker
      return mod
    })
  }
  return pdfjsPromise
}

export async function importPdf(file: File, opts: ImportOptions = {}): Promise<ImportedBook> {
  const pdfjs = await loadPdfjs()
  const warn: string[] = []
  const data = new Uint8Array(await file.arrayBuffer())
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise
  const maxSide = opts.maxSide ?? 1500
  const quality = opts.quality ?? 0.78
  const keepImages = opts.keepImages !== false
  const pages: Page[] = []
  let ocr = opts.ocr ? await createOcr().catch(() => null) : null
  if (opts.ocr && !ocr) warn.push('OCR engine not available here — pages without a text layer stayed image-only.')
  let ocrRun = 0

  for (let n = 1; n <= doc.numPages; n++) {
    opts.onProgress?.(`Pagina ${n}/${doc.numPages}`, n, doc.numPages)
    const page = await doc.getPage(n)
    const text = await extractPdfText(page)
    let image: string | undefined
    let imageW: number | undefined
    let imageH: number | undefined
    if (keepImages) {
      const viewport0 = page.getViewport({ scale: 1 })
      const scale = Math.min(2.2, Math.max(0.4, maxSide / Math.max(viewport0.width, viewport0.height)))
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      const ctx = canvas.getContext('2d')
      if (ctx) {
        await page.render({ canvasContext: ctx, viewport, background: '#ffffff' } as unknown as Parameters<typeof page.render>[0]).promise
        image = canvas.toDataURL('image/jpeg', quality)
        imageW = canvas.width
        imageH = canvas.height
      }
    }
    let kind: Page['ocr'] = text.trim() ? 'text' : 'none'
    if (!text.trim() && image && ocr && ocrRun < (opts.ocrLimit ?? 250)) {
      ocrRun++
      const got = await recognize(ocr, image)
      if (got) {
        pages.push({ id: uid('p'), bookId: '', n, text: got, image, imageW, imageH, ocr: 'ocr' })
        continue
      }
    }
    pages.push({ id: uid('p'), bookId: '', n, text, image, imageW, imageH, ocr: kind })
    page.cleanup()
  }
  if (ocr) await destroyOcr(ocr)
  await doc.destroy()

  const withText = pages.filter((p) => p.text.trim().length > 20).length
  const book: Book = {
    id: uid('k'),
    title: opts.title?.trim() || file.name.replace(/\.pdf$/i, ''),
    author: opts.author,
    subjectId: opts.subjectId,
    pageCount: pages.length,
    origin: 'pdf',
    quality: keepImages ? `${maxSide}px / q${quality}` : 'testo',
    textCoverage: pages.length ? withText / pages.length : 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  for (const p of pages) p.bookId = book.id
  if (!withText && keepImages) warn.push('Nessun testo nel PDF (è una scansione): cerca e AI useranno le pagine come immagini, oppure importa di nuovo con OCR attivo.')
  return { book, pages, warnings: warn }
}

/** pdf.js text items -> reading-order lines, de-hyphenated. */
export function pdfItemsToText(items: { str: string; transform: number[] }[]): string {
  const lines: { y: number; parts: { x: number; s: string }[] }[] = []
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue
    const x = it.transform[4] ?? 0
    const y = it.transform[5] ?? 0
    let line = lines.find((l) => Math.abs(l.y - y) < 3.2)
    if (!line) {
      line = { y, parts: [] }
      lines.push(line)
    }
    line.parts.push({ x, s: it.str })
  }
  lines.sort((a, b) => b.y - a.y)
  const raw = lines.map((l) =>
    l.parts
      .sort((a, b) => a.x - b.x)
      .map((p) => p.s)
      .join('')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  const out: string[] = []
  for (const line of raw) {
    if (!line) {
      if (out.at(-1) !== '') out.push('')
      continue
    }
    const prev = out.at(-1)
    if (prev && /-\u00ad?$/.test(prev)) out[out.length - 1] = prev.replace(/-\u00ad?$/, '') + line.charAt(0).toLowerCase() + line.slice(1)
    else out.push(line)
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function extractPdfText(page: { getTextContent: () => Promise<{ items: unknown[] }> }) {
  try {
    const tc = await page.getTextContent()
    return pdfItemsToText(tc.items as { str: string; transform: number[] }[])
  } catch {
    return ''
  }
}

/* ============================================================ OCR (local) */

export type OcrWorker = { recognize: (image: string) => Promise<{ data: { text: string } }>; terminate: () => Promise<void> }
let ocrPromise: Promise<OcrWorker | null> | null = null

export async function createOcr(): Promise<OcrWorker | null> {
  if (!ocrPromise) {
    ocrPromise = (async () => {
      if (typeof Worker !== 'function') return null
      try {
        const mod = await import('tesseract.js')
        const workerUrl = (await import('tesseract.js/dist/worker.min.js?url')).default
        const coreUrl = (await import('tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url')).default
        const worker = await mod.createWorker('ita', 1, {
          workerPath: workerUrl,
          corePath: coreUrl.replace(/[^/]+$/, ''),
          langPath: '/tessdata',
          gzip: true,
          workerBlobURL: false,
          logger: () => undefined,
        })
        return {
          recognize: async (image: string) => {
            const { data } = await worker.recognize(image)
            return { data: { text: data.text ?? '' } }
          },
          terminate: async () => { await worker.terminate() },
        } satisfies OcrWorker
      } catch {
        // no Worker, no WASM, offline CDN: OCR just stays off, the import still works
        ocrPromise = Promise.resolve(null)
        return null
      }
    })()
  }
  return ocrPromise
}

export async function recognize(worker: OcrWorker, image: string): Promise<string> {
  try {
    const { data } = await worker.recognize(image)
    return cleanOcr(data.text)
  } catch {
    return ''
  }
}

export const destroyOcr = async (worker: OcrWorker | null) => {
  try {
    await worker?.terminate()
  } catch {
    /* nothing to do */
  }
  ocrPromise = null
}

/** tesseract noise removal, shared with tests */
export function cleanOcr(text: string): string {
  return text
    .replace(/\u00ad/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]{2,}/g, ' ').trim())
    .filter((l, i, a) => l || a[i - 1] !== '')
    .join('\n')
    .replace(/([a-zàèéìòù])-\n([a-zàèéìòù])/gi, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function ocrAvailable() {
  return (await createOcr()) !== null
}

/* ============================================================ blank book */

export function blankBook(title: string, pageCount: number, opts: Partial<ImportOptions> = {}): ImportedBook {
  const book: Book = {
    id: uid('k'),
    title: title.trim() || 'Libro',
    author: opts.author,
    subjectId: opts.subjectId,
    pageCount: Math.max(1, Math.min(5000, Math.round(pageCount))),
    origin: 'manual',
    textCoverage: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const pages: Page[] = []
  for (let n = 1; n <= book.pageCount; n++) pages.push({ id: uid('p'), bookId: book.id, n, text: '', ocr: 'none' })
  return { book, pages, warnings: ['Ricorda: puoi incollare il testo pagina per pagina dal lettore della casa editrice.'] }
}

export async function measureDataUrl(dataUrl: string): Promise<{ w: number; h: number } | null> {
  if (typeof Image === 'undefined') return null
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

export const EPUB_MAGIC = EP_MAGIC
