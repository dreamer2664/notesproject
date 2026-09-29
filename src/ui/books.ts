import { blankBook, importImages, importPdf, ocrAvailable, parseEpub, type ImportOptions, type ImportedBook } from '../core/import'
import type { Block, Book } from '../core/types'
import { bookBytes, createNote, createTopic, deleteBook, listBooks, listNotes, listTopics, putBook, putPages } from '../core/db'
import { uid } from '../core/util'
import { dropIndex } from '../core/ai'
import { canPickFolder, ensurePermission, pickFolder, writeFilesToFolder } from '../core/fs'
import { vaultToBookFiles } from '../core/md'
import { el, modal, toast } from './dom'
import { icons } from './icons'
import { App, routes } from './state'

/* ====================================================== the import pipeline */

type Kind = 'epub' | 'pdf' | 'images' | 'manual'

interface Plan {
  kind: Kind
  label: string
  files: File[]
  note: string
}

function plan(files: File[]): Plan[] {
  const out: Plan[] = []
  const epub = files.filter((f) => /\.epub$/i.test(f.name))
  const pdf = files.filter((f) => /\.pdf$/i.test(f.name))
  const imgs = files.filter((f) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name))
  const txt = files.filter((f) => /\.(txt|md|html?)$/i.test(f.name))
  if (epub.length) out.push({ kind: 'epub', label: 'EPUB', files: epub, note: 'Formato di Adobe Digital Editions / laZ “Download ebook” / “libro liquido” di Sanoma. Il testo viene estratto, le figure restano come immagini: niente chiave, niente DRM.' })
  if (pdf.length) out.push({ kind: 'pdf', label: 'PDF', files: pdf, note: 'Ogni pagina diventa immagine + testo. Se il PDF non ha il testo (scansione), entra l’OCR.' })
  if (imgs.length >= 2) out.push({ kind: 'images', label: `${imgs.length} immagini`, files: imgs, note: 'Una foto o uno screenshot per pagina, ordinati per numero nel nome (001.png, 002.png…). Le pagine passano all’OCR per avere il testo.' })
  if (txt.length) out.push({ kind: 'manual', label: `${txt.length} file di testo`, files: txt, note: 'Testo puro: lo spezziamo in pagine. Utile per gli appunti presi dal reader dell’editore.' })
  return out
}

/** The one dialog that starts every import. */
export async function openImport(preselect?: File[]) {
  const state: { files: File[]; running: boolean } = { files: [], running: false }
  const body = el('div', { class: 'import-modal' })

  const drop = el('div', { class: 'drop', tabindex: '0' },
    el('b', { text: 'Trascina qui il file del libro' }),
    el('p', { class: 'lede dim', html: 'EPUB (Adobe Digital Editions, laZ “Scarica”, “libro liquido” Sanoma) · PDF · cartella di immagini · .txt/.md. Oppure <b>sfoglia</b>.' }))
  const picker = el('input', { type: 'file', multiple: 'true', class: 'hidden-file', accept: '.epub,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.txt,.md,.html' })
  picker.addEventListener('change', () => {
    if (picker.files?.length) setFiles(Array.from(picker.files))
  })
  drop.addEventListener('click', () => picker.click())
  drop.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') picker.click()
  })
  drop.addEventListener('dragover', (e: Event) => {
    e.preventDefault()
    drop.classList.add('over')
  })
  drop.addEventListener('dragleave', () => drop.classList.remove('over'))
  drop.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault()
    drop.classList.remove('over')
    const list = Array.from(e.dataTransfer?.files ?? [])
    if (!list.length) {
      toast('Il browser non legge le cartelle trasciniate: usa “sfoglia” e seleziona i file (Ctrl+A nella cartella)')
      return
    }
    setFiles(list)
  })

  const planBox = el('div', { class: 'import-plan' })
  const title = el('input', { class: 'field', placeholder: 'titolo del libro (altrimenti lo deduco dai file)' })
  const author = el('input', { class: 'field', placeholder: 'autore / casa editrice (facoltativo)' })
  const subjectSel = el('select', { class: 'field' }, el('option', { value: '', text: '— nessun soggetto —' }), ...App.subjects.map((s) => el('option', { value: s.id, text: `${s.emoji} ${s.name}` })))
  const imageSize = el('select', { class: 'field' }, ...[['1200 (leggero)', 1200], ['1500 (consigliato)', 1500], ['2000 (figure nitide)', 2000], ['nessuna immagine (solo testo)', 0]].map(([label, v]) => el('option', { value: String(v), text: String(label), ...(v === 1500 ? { selected: true } : {}) })))
  const quality = el('input', { class: 'field', type: 'range', min: '0.55', max: '0.92', step: '0.01', value: '0.78' })
  const qLabel = el('b', { text: '0.78' })
  quality.addEventListener('input', () => (qLabel.textContent = Number(quality.value).toFixed(2)))
  const ocr = el('input', { type: 'checkbox' })
  const epubSplit = el('input', { class: 'field', type: 'number', min: '12', max: '120', value: '34' })
  const go = el('button', { class: 'btn primary', type: 'button', text: 'Importa', disabled: true }) as HTMLButtonElement
  const progress = el('div', { class: 'import-progress', hidden: true })
  const bar = el('div', { class: 'bar' })
  const barFill = el('div', { class: 'fill' })
  bar.append(barFill)
  const progMsg = el('span', { text: '' })
  const cancelHint = el('span', { class: 'lede dim', text: 'Puoi lasciare questa finestra aperta: importa anche se cambi scheda.' })
  progress.append(bar, el('div', { class: 'row-btns' }, progMsg, cancelHint))

  body.append(drop, picker, planBox,
    el('div', { class: 'import-grid' },
      fieldRow('Titolo', title),
      fieldRow('Autore', author),
      fieldRow('Soggetto (per vederlo nella sua home)', subjectSel),
      fieldRow('Immagine di ogni pagina', imageSize),
      fieldRow('Compressione immagini', el('span', { class: 'field-inline' }, qLabel, ' ', quality)),
      fieldRow('Pagine EPUB (righe per pagina)', epubSplit),
      fieldRow('OCR', el('label', { class: 'inline-check' }, ocr, el('span', { class: 'lede', text: 'riconosci il testo nelle pagine senza testo' })))),
    go,
    progress)

  const setFiles = (list: File[]) => {
    state.files = list
    const plans = plan(list)
    planBox.replaceChildren(
      ...(plans.length
        ? plans.map((p) => el('div', { class: 'plan-row' }, el('span', { class: 'plan-kind', text: p.label }), el('p', { class: 'lede', text: p.note })))
        : [el('p', { class: 'lede dim', text: list.length ? 'Nessun formato leggibile qui dentro. Rinuncia al DRM del reader dell’editore: esporta/importa quello che ti dà (EPUB, PDF, immagini).' : '' })]),
    )
    if (!list.length) planBox.replaceChildren()
    go.disabled = !list.length
    go.textContent = list.length ? `Importa ${list.length} file` : 'Importa'
  }
  void ocrAvailable().then((ok) => {
    ocr.textContent = ok ? 'OCR disponibile (modello italiano incluso nell’app, funziona anche offline)' : 'OCR non disponibile su questo browser'
    ocr.disabled = !ok
  })

  const scrim = el('div', { class: 'scrim' }, el('div', { class: 'modal wide' },
    el('header', {}, el('h2', { text: 'Importa un libro' }), el('p', { class: 'sub', text: 'Il libro resta sul tuo dispositivo: IndexedDB nel browser, e in un folder se lo esporti.' })),
    body,
    el('footer', {},
      el('button', { class: 'btn ghost', type: 'button', text: 'Chiudi', onclick: () => scrim.remove() }),
      el('button', { class: 'btn ghost', type: 'button', text: 'Ho solo il reader dell’editore', onclick: () => void manualEntry() }),
      go)))
  go.addEventListener('click', () => void run())

  async function run() {
    if (state.running) return
    const files = state.files
    if (!files.length) return
    state.running = true
    go.disabled = true
    progress.hidden = false
    const opts: ImportOptions = {
      title: title.value.trim() || undefined,
      author: author.value.trim() || undefined,
      subjectId: subjectSel.value || undefined,
      maxSide: Number(imageSize.value) || undefined,
      quality: Number(quality.value),
      keepImages: Number(imageSize.value) !== 0,
      ocr: ocr.checked,
      epubLinesPerPage: Math.max(12, Number(epubSplit.value) || 34),
      onProgress: (msg, done, total) => {
        progMsg.textContent = msg
        if (done != null && total) barFill.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`
      },
    }
    try {
      const results: ImportedBook[] = []
      for (const f of files.filter((x) => /\.epub$/i.test(x.name))) results.push(await parseEpub(await f.arrayBuffer(), opts))
      for (const f of files.filter((x) => /\.pdf$/i.test(x.name))) results.push(await importPdf(f, opts))
      const imgFiles = files.filter((x) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(x.name))
      if (imgFiles.length) {
        const mapped = await Promise.all(
          imgFiles.map(async (f) => ({ name: f.name, blob: f as unknown as Blob })),
        )
        results.push(await importImages(mapped, opts))
      }
      const txts = files.filter((x) => /\.(txt|md)$/i.test(x.name))
      if (txts.length) results.push(await textBook(txts, opts))
      if (!results.length) throw new Error('Nessun file leggibile: EPUB, PDF, immagini o .txt/.md')
      const saved: Book[] = []
      for (const r of results) {
        r.book.id = r.book.id || uid('k')
        for (const p of r.pages) p.bookId = r.book.id
        await putBook(r.book)
        await putPages(r.pages)
        saved.push(r.book)
        for (const w of r.warnings) toast(w)
      }
      App.emit()
      scrim.remove()
      const first = saved[0]!
      toast(saved.length > 1 ? `${saved.length} libri importati` : `"${first.title}" è dentro (${first.pageCount} pagine)`)
      location.hash = routes.book(first.id, 1)
    } catch (err) {
      state.running = false
      go.disabled = false
      progress.hidden = true
      progMsg.textContent = ''
      const msg = (err as Error).message ?? String(err)
      toast(/drm|encrypted|password/i.test(msg)
        ? 'Il file è protetto da DRM: apri prima il download con Adobe Digital Editions (o l’app della casa editrice) e usa il suo “esporta/Scarica ebook”, poi importa l’EPUB.'
        : `Importazione fallita: ${msg}`)
    }
  }

  document.body.append(scrim)
  scrim.addEventListener('pointerdown', (e) => {
    if (e.target === scrim && !state.running) scrim.remove()
  })
  if (preselect?.length) setFiles(preselect)
}

/** .txt / .md -> a manual book, split every N lines. */
async function textBook(files: File[], opts: ImportOptions): Promise<ImportedBook> {
  const pages = (await Promise.all(files.map(async (f) => (await f.text()).replace(/\r\n/g, '\n').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)))).flat()
  const per = opts.epubLinesPerPage ?? 34
  const chunks: string[] = []
  for (let i = 0; i < pages.length; i += Math.max(4, Math.floor(per / 3))) chunks.push(pages.slice(i, i + Math.max(4, Math.floor(per / 3))).join('\n\n'))
  const book: Book = {
    id: uid('k'),
    title: opts.title?.trim() || files[0]!.name.replace(/\.(txt|md)$/i, '') || 'Testo',
    author: opts.author,
    subjectId: opts.subjectId,
    pageCount: chunks.length,
    origin: 'manual',
    textCoverage: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  return {
    book,
    pages: chunks.map((text, i) => ({ id: uid('p'), bookId: book.id, n: i + 1, text, ocr: 'text' as const })),
    warnings: chunks.length ? [] : ['Nessun testo trovato nel file'],
  }
}

/** Last door: no file at all — you create the skeleton and paste pages one by one. */
async function manualEntry() {
  const scrim = document.querySelector('.scrim')
  const title = el('input', { class: 'field', placeholder: 'es. Matematica blu — volume 1' })
  const count = el('input', { class: 'field', type: 'number', min: '1', max: '2000', value: '300' })
  const subjectSel = el('select', { class: 'field' }, el('option', { value: '', text: '— nessun soggetto —' }), ...App.subjects.map((s) => el('option', { value: s.id, text: s.name })))
  const ok = el('button', { class: 'btn primary', type: 'button', text: 'Crea' })
  const box = el('div', { class: 'modal' },
    el('header', {}, el('h2', { text: 'Libro da incollare a mano' }), el('p', { class: 'sub', text: 'Utile quando il reader dell’editore non dà nessun file: crei le pagine vuote (con i margini per la penna) e ci incolli il testo che riesci a selezionare, pagina per pagina.' })),
    el('div', { class: 'import-grid' }, fieldRow('Titolo', title), fieldRow('Quante pagine', count), fieldRow('Soggetto', subjectSel)),
    el('footer', {}, el('button', { class: 'btn ghost', type: 'button', text: 'Annulla', onclick: () => box.closest('.scrim')?.remove() }), ok))
  const overlay = el('div', { class: 'scrim' }, box)
  ok.addEventListener('click', async () => {
    const res = blankBook(title.value.trim() || 'Libro', Math.max(1, Number(count.value) || 1), { subjectId: subjectSel.value || undefined })
    for (const p of res.pages) p.bookId = res.book.id
    await putBook(res.book)
    await putPages(res.pages)
    App.emit()
    overlay.remove()
    scrim?.remove()
    location.hash = routes.book(res.book.id, 1)
    toast('Ora apri una pagina e premi “Incolla il testo in questa pagina”')
  })
  document.body.append(overlay)
  title.focus()
}

function fieldRow(label: string, input: HTMLElement) {
  return el('label', { class: 'field-row' }, el('span', { class: 'field-label', text: label }), input)
}

/* ============================================================ books (views) */

export async function renderBooks(host: HTMLElement) {
  const books = await listBooks()
  if (!(window as unknown as { __bookDrop?: boolean }).__bookDrop) {
    ;(window as unknown as { __bookDrop: boolean }).__bookDrop = true
    window.addEventListener('dragover', (e) => {
      if (location.hash.startsWith('#/books')) e.preventDefault()
    })
    window.addEventListener('drop', (e) => {
      if (!location.hash.startsWith('#/books')) return
      const list = Array.from(e.dataTransfer?.files ?? [])
      if (!list.length) return
      e.preventDefault()
      void openImport(list)
    })
  }
  const wrap = el('div', { class: 'lib' })
  const head = el('div', { class: 'lib-head' },
    el('h1', { class: 'lib-title' }, el('span', { text: 'Testi' })),
    el('p', { class: 'lede dim', text: books.length ? `${books.length} libri in archivio, sul tuo dispositivo. Clicca per aprire il lettore.` : 'EPUB, PDF o cartelle di pagine: qui dentro diventano libri cercabili, con OCR e penna.' }),
    el('button', { class: 'btn primary', type: 'button', text: 'Importa un libro', onclick: () => void openImport() }))
  wrap.append(head)
  if (!books.length) {
    wrap.append(el('div', { class: 'empty' }, el('p', { class: 'empty-big', text: 'Nessun libro, per ora' }), el('p', { class: 'lede', text: 'Il modo più rapido: dal sito della casa editrice scarica l’EPUB (laZ: “Download ebook” → Adobe Digital Editions; Sanoma: “libro liquido”), poi trascinalo qui.' })))
    host.replaceChildren(wrap)
    return
  }
  const grid = el('div', { class: 'book-grid' })
  for (const b of books) grid.append(await bookCard(b))
  wrap.append(grid)
  host.replaceChildren(wrap)
}

export async function renderSubjectBooks(subjectId: string): Promise<HTMLElement> {
  const books = (await listBooks()).filter((b) => b.subjectId === subjectId)
  if (!books.length) return el('div', { class: 'subject-books' }, el('button', { class: 'btn ghost small', type: 'button', text: 'Importa un libro per questo soggetto', onclick: () => void openImport() }))
  const row = el('div', { class: 'subject-books' })
  for (const b of books) row.append(await bookCard(b, true))
  row.append(el('button', { class: 'btn ghost small', type: 'button', text: '+ libro', onclick: () => void openImport() }))
  return row
}

export async function bookCard(book: Book, compact = false) {
  const bytes = await bookBytes(book.id)
  const pct = Math.round((book.textCoverage ?? 0) * 100)
  const card = el('article', { class: `book-card${compact ? ' compact' : ''}` })
  card.append(
    el(
      'a',
      { class: 'book-open', href: routes.book(book.id, 1) },
      el('div', { class: 'cover' }, el('span', { class: 'cover-title', text: book.title }), el('span', { class: 'cover-origin', text: originLabel(book.origin) })),
      el('h3', { class: 'book-name', text: book.title }),
      book.author ? el('p', { class: 'book-author', text: book.author }) : null,
      el('p', { class: 'book-meta', text: `${book.pageCount} pagine · testo ${pct}% · ${(bytes / 1e6).toFixed(1)} MB` }),
      pct < 25 ? el('p', { class: 'book-warn', text: 'poco testo: fai OCR o incolla le pagine che ti servono' }) : null,
    ),
    el(
      'div',
      { class: 'row-btns' },
      el('button', { class: 'btn small ghost', type: 'button', text: 'Esporta in un folder', onclick: () => void exportBook(book) }),
      el('button', { class: 'btn small ghost', type: 'button', text: 'Appunti', onclick: () => void bookNotes(book) }),
      el('button', {
        class: 'btn small ghost',
        type: 'button',
        title: 'Rimuovi il libro (gli appunti restano)',
        html: icons.trash,
        onclick: async () => {
          const r = await modal({
            title: `Eliminare "${book.title}"?`,
            subtitle: `${book.pageCount} pagine e le immagini spariscono. Gli appunti che citano le pagine restano (segnalano solo che la pagina non c'è più).`,
            actions: [
              { label: 'Annulla', kind: 'ghost', value: '' },
              { label: 'Elimina', kind: 'danger', value: 'ok' },
            ],
          })
          if (!r) return
          await deleteBook(book.id)
          dropIndex(book.id)
          App.emit()
          toast('Libro eliminato')
        },
      }),
    ),
  )
  return card
}

const originLabel = (o: Book['origin']) => (o === 'epub' ? 'EPUB' : o === 'pdf' ? 'PDF' : o === 'images' ? 'immagini' : 'a mano')

async function exportBook(book: Book) {
  if (!canPickFolder()) return toast('Questo browser non scrive su disco: usa Esporta .md dal menu del lettore, o Chrome/Edge.')
  const root = await pickFolder()
  if (!root) return
  if (!(await ensurePermission(root))) return toast('Permesso negato sul folder')
  const files = await vaultToBookFiles(book)
  const n = await writeFilesToFolder(root, files)
  toast(`${n} file scritti in “${root.name}” — OneDrive/Syncthing li sincronizzeranno`)
}

async function bookNotes(book: Book) {
  const hits: { subjectId: string; topicId: string; noteId: string; title: string; icon: string; pages: number[] }[] = []
  for (const subject of App.subjects) {
    for (const topic of await listTopics(subject.id)) {
      for (const note of await listNotes(topic.id)) {
        const pages = note.blocks.filter((b) => b.type === 'page' && b.bookId === book.id).map((b) => b.pageNumber ?? 0)
        if (pages.length) hits.push({ subjectId: subject.id, topicId: topic.id, noteId: note.id, title: note.title, icon: note.icon, pages })
      }
    }
  }
  const body = el('div', { class: 'book-notes' })
  if (!hits.length) {
    body.append(el('p', { class: 'lede dim', text: 'Nessun appunto cita pagine di questo libro. Nel lettore: Testo → “Cita in un appunto”.' }))
  }
  for (const hit of hits) {
    const where = App.subjectById.get(hit.subjectId)?.name ?? ''
    const what = App.topicById.get(hit.topicId)?.name ?? ''
    const link = el('a', { class: 'cite-row', href: routes.note(hit.subjectId, hit.topicId, hit.noteId) })
    link.append(el('span', { class: 'cite-icon', text: hit.icon }))
    const txt = el('span', { class: 'cite-txt' })
    txt.append(el('b', { text: hit.title }))
    txt.append(el('span', { class: 'cite-sub', text: `${where} › ${what} · ${hit.pages.map((pg) => `p. ${pg}`).join(' · ')}` }))
    link.append(txt)
    body.append(link)
  }
  const scrim = el('div', { class: 'scrim' }, el('div', { class: 'modal' }, el('header', {}, el('h2', { text: `Appunti su "${book.title}"` })), body, el('footer', {}, el('button', { class: 'btn primary', type: 'button', text: 'Chiudi', onclick: () => scrim.remove() }))))
  document.body.append(scrim)
  scrim.addEventListener('pointerdown', (e) => {
    if (e.target === scrim) scrim.remove()
  })
}

/** "Inserisci questa pagina in un appunto", from the palette or the reader. */
export async function attachPageToNote(book: Book, page: number) {
  const subject = App.subjects[0]
  if (!subject) return toast('Crea prima un soggetto')
  const topics = await listTopics(subject.id)
  const topic = topics[0] ?? (await createTopic(subject.id, 'Dal libro'))
  const blocks: Block[] = [
    { id: uid('b'), type: 'page', label: book.title, bookId: book.id, pageNumber: page },
    { id: uid('b'), type: 'text', content: '' },
  ]
  const note = await createNote(topic.id, `${book.title} p. ${page}`, blocks)
  App.emit()
  location.hash = routes.note(subject.id, topic.id, note.id)
}
