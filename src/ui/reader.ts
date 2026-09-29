import type { Block } from '../core/types'
import {
  bookBytes,
  createNote,
  createTopic,
  db,
  deleteBook,
  listNotes,
  getBook,
  getPage,
  listTopics,
  pageTexts,
  putPages,
  setPageInk,
} from '../core/db'
import type { Book, Page } from '../core/types'
import { uid } from '../core/util'
import { mountInk, type InkApi } from '../core/ink'
import { Bm25, buildIndex, citePage } from '../core/search'
import { ask, cachedIndex, checkOllama, dropIndex, getAiSettings, mdToHtml, setAiSettings, stopAll, TASKS } from '../core/ai'
import { downloadText, ensurePermission, pickFolder, writeFilesToFolder } from '../core/fs'
import { vaultToBookFiles } from '../core/md'
import { aiSettingsModal } from './ai-settings'
import { el, modal, toast } from './dom'
import { studyStrip } from './scan'
import { maybeStudyAhead } from '../core/study'
import { icons } from './icons'
import { App, routes } from './state'

/** Router handle: a page change inside a book must not re-render the whole reader. */
let active: { bookId: string; setPage: (n: number) => void } | null = null
export const patchReader = (bookId: string, page?: number): boolean => {
  if (!active || active.bookId !== bookId) return false
  if (page) active.setPage(page)
  return true
}
export const closeReader = () => {
  active = null
  stopAll()
}

type TabKey = 'testo' | 'appunti' | 'ai' | 'cerca'

const clamp = (n: number, max: number) => Math.max(1, Math.min(Math.max(1, max), Math.round(n || 1)))
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function renderReader(host: HTMLElement, bookId: string, startPage: number, signal: AbortSignal) {
  const book = await getBook(bookId)
  if (!book) {
    host.replaceChildren(
      el('div', { class: 'empty' }, el('p', { class: 'empty-big', text: 'Libro non trovato' }), el('a', { class: 'btn', href: routes.all, text: 'Torna ai soggetti' })),
    )
    return
  }

  let page = clamp(startPage, book.pageCount)
  let current: Page | undefined
  let index: Bm25 | null = cachedIndex(book.id) ?? null
  let fitMode: 'width' | 'page' | 'raw' = 'width'
  let zoom = 1
  let drawOn = false
  let busy = false
  let tab: TabKey = 'testo'
  let ink: InkApi | null = null

  const root = el('div', { class: 'reader' })
  const top = el('div', { class: 'reader-top' })
  const split = el('div', { class: 'reader-split' })
  const paneL = el('section', { class: 'pane pane-page' })
  const paneR = el('section', { class: 'pane pane-side' })
  split.append(paneL, paneR)
  root.append(top, split)
  host.replaceChildren(root)

  /* ------------------------------------------------------------- top bar */
  const pageInput = el('input', { class: 'page-jump', type: 'number', min: '1', max: String(book.pageCount), value: String(page), title: 'Vai a pagina (Invio)' })
  pageInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      setPage(Number(pageInput.value))
      pageInput.blur()
    }
  })
  const rbtn = (html: string, title: string, fn: () => void, cls = '') => el('button', { class: `rbtn ${cls}`.trim(), type: 'button', title, html, onclick: () => void fn() })
  top.append(
    el('a', { class: 'rback', href: routes.all, title: 'Soggetti', html: icons.chevron }),
    el('div', { class: 'rtitle' }, el('b', { text: book.title }), book.author ? el('span', { class: 'rauthor', text: book.author }) : null),
    el(
      'div',
      { class: 'rnav' },
      rbtn(icons.chevron, 'Pagina precedente (←)', () => setPage(page - 1), 'flip'),
      pageInput,
      el('span', { class: 'rof', text: `/ ${book.pageCount}` }),
      rbtn(icons.chevron, 'Pagina successiva (→)', () => setPage(page + 1)),
    ),
    el(
      'div',
      { class: 'rtools' },
      rbtn(PEN_SVG, 'Scrivi sulla pagina (penna)', () => {
        drawOn = !drawOn
        ink?.setEnabled(drawOn)
        paneL.classList.toggle('drawing', drawOn)
        drawBtn.classList.toggle('on', drawOn)
      }, 'draw'),
      rbtn(icons.refresh, 'Adatta: larghezza → pagina intera → dimensioni reali', () => {
        fitMode = fitMode === 'width' ? 'page' : fitMode === 'page' ? 'raw' : 'width'
        stage.dataset.fit = fitMode
        applyZoom()
      }),
      rbtn(icons.book, 'Libro: copertura testo, OCR, export, eliminazione', () => void bookMenu(book, index)),
      rbtn(GEAR_SVG, 'Impostazioni AI', () => void aiSettings(() => refreshAiState())),
    ),
  )
  const drawBtn = top.querySelector<HTMLButtonElement>('.rbtn.draw')!

  /* ----------------------------------------------------------- page pane */
  const stage = el('div', { class: 'page-view' })
  stage.dataset.fit = fitMode
  const foot = el('div', { class: 'page-foot' })
  paneL.append(stage, foot)
  ink = mountInk(stage, {
    strokes: [],
    enabled: false,
    noToolbar: true,
    onChange: (strokes) => {
      if (!current) return
      void setPageInk(book.id, current.n, strokes)
      foot.querySelector('.ink-count')?.replaceChildren(el('span', { text: `${strokes.length} tratti` }))
    },
  })
  const applyZoom = () => stage.style.setProperty('--zoom', String(zoom))

  const renderPage = async () => {
    current = await getPage(book.id, page)
    stage.querySelector('img, .page-blank')?.remove()
    if (current?.image) {
      stage.prepend(el('img', { src: current.image, alt: `pagina ${page}`, draggable: 'false' }))
    } else {
      stage.prepend(el('div', { class: 'page-blank' }, el('pre', { text: current?.text?.trim() || 'Pagina senza immagine e senza testo: importa le pagine come immagini, o incolla qui il testo.' })))
    }
    ink?.setStrokes(current?.ink ?? [])
    if (pageInput.isConnected) pageInput.value = String(page)
    const label = current?.ocr === 'text' ? 'testo dal file' : current?.ocr === 'ocr' ? 'testo da OCR' : current?.image ? 'solo immagine (nessun testo)' : 'vuota'
    foot.replaceChildren(
      el('span', { text: label }),
      el('span', { class: 'dot' }),
      el('span', { class: 'ink-count', text: `${current?.ink?.length ?? 0} tratti` }),
      el('span', { class: 'dot' }),
      el('button', { class: 'link-btn', type: 'button', text: 'Incolla il testo in questa pagina', onclick: () => void pastePageText(book, page, () => void renderPage()) }),
      el('span', { class: 'flex' }),
      el('button', { class: 'link-btn', type: 'button', text: 'Zoom', onclick: () => {
        zoom = zoom >= 2 ? 0.6 : zoom + 0.35
        applyZoom()
      } }),
    )
  }

  const setPage = (n: number) => {
    const next = clamp(n, book.pageCount)
    if (next === page) return
    page = next
    void renderPage()
    void renderSide()
    if (next !== page) return
    try {
      history.replaceState(null, '', `#/b/${book.id}?p=${next}`)
    } catch {
      /* the view was already torn down */
    }
  }
  active = { bookId: book.id, setPage }

  window.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable="true"]')) return
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        setPage(page - 1)
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        setPage(page + 1)
      } else if (e.key === '+' || e.key === '=') {
        zoom = Math.min(3, zoom + 0.15)
        applyZoom()
      } else if (e.key === '-') {
        zoom = Math.max(0.4, zoom - 0.15)
        applyZoom()
      } else if (e.key.toLowerCase() === 'p') {
        drawBtn.click()
      }
    },
    { signal },
  )

  /* ----------------------------------------------------------- side pane */
  const tabsBar = el('div', { class: 'side-tabs' })
  const sideBody = el('div', { class: 'side-body' })
  paneR.append(tabsBar, sideBody)
  const TABS: [TabKey, string][] = [
    ['testo', 'Testo'],
    ['appunti', 'Appunti'],
    ['ai', 'AI'],
    ['cerca', 'Cerca'],
  ]
  const renderSide = async () => {
    tabsBar.replaceChildren(
      ...TABS.map(([key, label]) =>
        el('button', {
          class: `side-tab${tab === key ? ' on' : ''}`,
          type: 'button',
          text: label,
          onclick: () => {
            tab = key
            void renderSide()
          },
        }),
      ),
    )
    if (tab === 'testo') await renderTextTab()
    else if (tab === 'appunti') await renderNotesTab()
    else if (tab === 'ai') renderAiTab()
    else await renderSearchTab()
  }

  const renderTextTab = async () => {
    const p = current ?? (await getPage(book.id, page))
    const text = p?.text?.trim() ?? ''
    const box = el('div', { class: 'tab-body' })
    if (!text) {
      box.append(
        el('p', { class: 'side-hint', text: p?.image ? 'Questa pagina è solo un’immagine. Con l’OCR dal menu del libro (⋮ → Libro) diventa cercabile; oppure incolla qui il testo che riesci a selezionare nel reader dell’editore.' : 'Pagina vuota.' }),
        el('div', { class: 'row-btns' }, el('button', { class: 'btn small', type: 'button', text: 'Incolla il testo', onclick: () => void pastePageText(book, page, () => void renderPage()) })),
      )
      sideBody.replaceChildren(box)
      return
    }
    const ta = el('textarea', { class: 'page-text-edit', spellcheck: 'false', text })
    box.append(
      el(
        'div',
        { class: 'row-btns' },
        el('button', { class: 'btn small', type: 'button', text: 'Cita in un appunto', onclick: () => void citeIntoNote(book, page, text) }),
        el('button', { class: 'btn small', type: 'button', text: 'Chiedi all’AI', onclick: () => { tab = 'ai'; void renderSide() } }),
        el('button', {
          class: 'btn small primary',
          type: 'button',
          text: 'Salva testo',
          onclick: async () => {
            await putPages([{ ...(await getPage(book.id, page))!, text: ta.value }])
            dropIndex(book.id)
            index = null
            toast('Testo salvato — la prossima ricerca ricostruisce l’indice')
            await renderTextTab()
          },
        }),
      ),
      ta,
    )
    sideBody.replaceChildren(box)
  }

  const renderNotesTab = async () => {
    const box = el('div', { class: 'tab-body' })
    box.append(
      el('div', { class: 'row-btns' }, el('button', { class: 'btn small primary', type: 'button', text: `Nuovo appunto su p. ${page}`, onclick: () => void quickNoteFromPage(book, page) })),
    )
    const hits: { noteId: string; block: Block }[] = []
    for (const subject of App.subjects) {
      for (const topic of await listTopics(subject.id)) {
        for (const note of await listNotes(topic.id)) {
          const b = note.blocks.find((x) => x.type === 'page' && x.bookId === book.id)
          if (b) hits.push({ noteId: `${subject.id}/${topic.id}/${note.id}`, block: b })
        }
      }
    }
    if (!hits.length) {
      box.append(el('p', { class: 'side-hint', text: `Nessun appunto contiene ancora pagine di "${book.title}". Inseriscile dal blocco “Testo del libro” (blocco pagina) o da qui.` }))
      sideBody.replaceChildren(box)
      return
    }
    const list = el('div', { class: 'cites' })
    for (const h of hits) {
      const [subjectId, topicId, noteId] = h.noteId.split('/')
      const note = App.noteById.get(noteId!)
      list.append(
        el(
          'a',
          { class: 'cite-row', href: routes.note(subjectId!, topicId!, noteId!) },
          el('span', { class: 'cite-icon', text: note?.icon ?? '📄' }),
          el('span', { class: 'cite-txt' }, el('b', { text: note?.title ?? 'appunto' }), el('span', { class: 'cite-sub', text: App.topicById.get(topicId!)?.name ?? '' })),
          h.block.pageNumber ? el('span', { class: 'cite-page', text: `p. ${h.block.pageNumber}` }) : null,
        ),
      )
    }
    box.append(el('h4', { class: 'side-h4', text: 'Appunti che citano questo libro' }), list)
    sideBody.replaceChildren(box)
  }

  /* ------------------------------------------------------------- AI tab */
  const aiLog = el('div', { class: 'ai-log' })
  const aiState = el('div', { class: 'ai-state' })
  const askBox = el('textarea', { class: 'ai-ask', rows: '3', placeholder: 'Chiedi qualcosa di questa pagina… Invio = chiedi, Shift+Invio = a capo' })
  const stopBtn = el('button', { class: 'btn small ghost', type: 'button', text: 'Stop', onclick: () => stopAll() })
  stopBtn.hidden = true
  const taskBar = el('div', { class: 'ai-tasks' }, ...TASKS.map((t) => el('button', { class: 'ai-task', type: 'button', title: t.prompt, text: t.label, onclick: () => void runAsk(t.key, '', t.label) })))
  const aiBody = el('div', { class: 'tab-body ai-body' }, aiState, aiLog, taskBar, askBox, el('div', { class: 'row-btns' }, el('button', { class: 'btn small primary', type: 'button', text: 'Chiedi', onclick: () => void runAsk('domanda', askBox.value) }), stopBtn))
  askBox.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void runAsk('domanda', askBox.value)
    }
  })

  const renderAiTab = () => {
    sideBody.replaceChildren(aiBody)
    void refreshAiState()
    aiBody.prepend(studyStrip(book.id, page, () => void renderAiTab()))
  }

  const refreshAiState = async () => {
    const cfg = getAiSettings()
    const st = await checkOllama(cfg.endpoint)
    if (st.status !== 'ok') {
      aiState.replaceChildren(
        el('span', { class: 'ai-off', text: st.status === 'cors' ? 'Ollama risponde ma blocca questa origine' : 'Nessun modello locale raggiungibile' }),
        el('button', { class: 'link-btn', type: 'button', text: 'configura', onclick: () => void aiSettings(() => refreshAiState()) }),
        el('span', { class: 'ai-tip', text: ' — intanto cerco nel libro e ti cito le pagine.' }),
      )
      return
    }
    const ready = !!cfg.model && st.models.includes(cfg.model)
    const visionOk = !!cfg.useVision && !!cfg.vision && st.visionModels.includes(cfg.vision)
    aiState.replaceChildren(
      el('span', { class: ready ? 'ai-on' : 'ai-off', text: ready ? `${cfg.model}` : 'modello non ancora scaricato' }),
      cfg.useVision ? el('span', { class: visionOk ? 'ai-on' : 'ai-off', text: ` visione: ${cfg.vision}${visionOk ? '' : ' (non caricato)'}` }) : el('span', { class: 'ai-tip', text: 'solo testo' }),
      el('button', { class: 'link-btn', type: 'button', text: 'cambia', onclick: () => void aiSettings(() => refreshAiState()) }),
      el('button', {
        class: 'link-btn',
        type: 'button',
        text: cfg.useVision ? 'non leggere l’immagine' : 'leggi anche l’immagine',
        onclick: async () => {
          await setAiSettings({ useVision: !cfg.useVision })
          void refreshAiState()
        },
      }),
      ...(ready ? [] : [el('span', { class: 'ai-tip', text: ` — pronti: ${st.models.slice(0, 3).join(', ') || 'nessuno: ollama pull qwen2.5:3b'}` })]),
    )
  }

  const runAsk = async (task: string, question: string, label?: string) => {
    if (busy) return
    busy = true
    stopBtn.hidden = false
    const text = question.trim()
    const cfg = getAiSettings()
    aiLog.append(el('div', { class: 'ai-msg you', html: text ? esc(text) : `<b>${esc(label ?? task)}</b>` }))
    const holder = el('div', { class: 'ai-msg ai pending' }, el('span', { class: 'ai-dots', text: 'sto leggendo p. ' + page + '…' }))
    aiLog.append(holder)
    aiLog.scrollTop = aiLog.scrollHeight
    let acc = ''
    const res = await ask(text, {
      config: cfg,
      book,
      page,
      task: task === 'domanda' ? undefined : task,
      index: index ?? undefined,
      image: cfg.useVision && cfg.vision ? current?.image : undefined,
      useDigests: true,
      onToken: (_c, full) => {
        acc = full
        holder.classList.remove('pending')
        holder.innerHTML = mdToHtml(acc)
        aiLog.scrollTop = aiLog.scrollHeight
      },
    })
    busy = false
    stopBtn.hidden = true
    if (res.error) {
      holder.replaceChildren(
        el('p', { class: 'ai-err', text: res.error }),
        el('button', { class: 'link-btn', type: 'button', text: 'Riprova senza modello (solo citazioni)', onclick: () => void runAsk(task, text, label) }),
      )
      return
    }
    holder.classList.remove('pending')
    holder.innerHTML =
      mdToHtml(res.text) + (res.mode === 'retrieval' ? '<p class="ai-mode">Nessun modello attivo: queste sono frasi testuali del libro, in ordine di pertinenza, con la pagina.</p>' : '')
    for (const a of Array.from(holder.querySelectorAll<HTMLElement>('a.cite[data-page]'))) {
      a.addEventListener('click', (e) => {
        e.preventDefault()
        setPage(Number(a.dataset.page))
      })
    }
    askBox.value = ''
    aiLog.scrollTop = aiLog.scrollHeight
  }

  /* ------------------------------------------------------- search tab */
  const renderSearchTab = async () => {
    const box = el('div', { class: 'tab-body' })
    const input = el('input', { class: 'side-search', type: 'search', placeholder: 'Cerca nel libro…' })
    const meta = el('div', { class: 'hits-meta' })
    const out = el('div', { class: 'hits' })
    const go = async () => {
      const q = input.value.trim()
      if (q.length < 2) {
        out.replaceChildren()
        meta.replaceChildren()
        return
      }
      if (!index) {
        meta.replaceChildren(el('span', { text: 'sto leggendo il testo del libro…' }))
        index = buildIndex(await pageTexts(book.id))
      }
      meta.replaceChildren(el('span', { text: `${index.size} brani, ${book.pageCount} pagine` }))
      const hits = index.search(q, 40)
      out.replaceChildren(
        ...(hits.length
          ? hits.map((hit) =>
              el(
                'button',
                { class: 'hit', type: 'button', onclick: () => setPage(hit.page) },
                el('span', { class: 'hit-page', text: String(hit.page) }),
                el('span', { class: 'hit-txt' }, el('p', { html: hl(Bm25.snippet(hit.text, q), q) })),
                el('span', { class: 'hit-score', text: hit.score.toFixed(1) }),
              ),
            )
          : [el('p', { class: 'side-hint', text: `Nessuna corrispondenza per “${q}”. Prova con una parola sola, senza accenti (es. "funzione"), e solo dopo l’OCR delle pagine.` })]),
      )
    }
    input.addEventListener('input', () => void go())
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') void go()
    })
    box.append(input, meta, out)
    sideBody.replaceChildren(box)
    input.focus()
  }

  /* ------------------------------------------------------------ start up */
  await renderPage()
  await renderSide()
  void maybeStudyAhead(book, page)
  signal.addEventListener('abort', () => {
    if (active?.bookId === book.id) active = null
    stopAll()
    ink?.destroy()
  })
}

/* =========================================================== helpers */

const GEAR_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.4"/><circle cx="7" cy="17" r="2.4"/></svg>'

const PEN_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 20l3.5-.8L20 6.7a2.1 2.1 0 0 0-3-3L4.5 16.2 4 20z"/></svg>'

function hl(text: string, query: string) {
  const safe = esc(text)
  const terms = query.split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 1)
  if (!terms.length) return safe
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return safe.replace(re, '<mark>$1</mark>')
}

async function pastePageText(book: Book, page: number, after: () => void) {
  let clip = ''
  try {
    clip = (await navigator.clipboard?.readText?.()) ?? ''
  } catch {
    clip = ''
  }
  const ta = el('textarea', { class: 'paste-area', spellcheck: 'false', 'data-field': 'text', placeholder: 'Seleziona il testo nel reader dell’editore, copialo (Ctrl+C), incolla qui (Ctrl+V)…' })
  ta.value = clip
  const res = await modal({
    title: `Testo di pagina ${page}`,
    subtitle: 'Con il testo, la ricerca e l’AI funzionano davvero. Puoi anche scriverlo a mano: va bene lo stesso.',
    body: el('div', { class: 'paste-box' }, ta),
    actions: [
      { label: 'Annulla', kind: 'ghost', value: '' },
      { label: 'Salva nella pagina', kind: 'primary', value: 'ok' },
    ],
  })
  if (!res) return
  const text = res.text ?? ''
  if (!text.trim()) return toast('Nessun testo da salvare')
  const existing = await getPage(book.id, page)
  await putPages([{ ...(existing ?? { id: uid('p'), bookId: book.id, n: page }), text, ocr: 'text' }])
  dropIndex(book.id)
  toast(`Pagina ${page}: testo salvato`)
  after()
  App.emit()
}

/** Book + page -> a note holding a live page block and a quote of the page text. */
async function citeIntoNote(book: Book, page: number, text: string) {
  const subject = App.subjects[0]
  if (!subject) return toast('Crea prima un soggetto')
  const res = await modal({
    title: 'Inserisci la pagina in un appunto',
    subtitle: `Un blocco-pagina (immagine + tuoi segni) e una citazione con il testo, in un appunto nuovo dentro “${subject.name}”.`,
    fields: [{ name: 'title', label: 'Titolo', value: `${book.title} p. ${page}`, placeholder: 'titolo dell’appunto' }],
    actions: [
      { label: 'Annulla', kind: 'ghost', value: '' },
      { label: 'Crea appunto', kind: 'primary', value: 'ok' },
    ],
  })
  if (!res) return
  await writePageNote(subject.id, book, page, text, res.title)
}

async function writePageNote(subjectId: string, book: Book, page: number, text: string, title?: string) {
  const topics = await listTopics(subjectId)
  const topic = topics[0] ?? (await createTopic(subjectId, 'Dal libro'))
  const note = await createNote(topic.id, (title ?? '').trim() || `${book.title} p. ${page}`, [
    { id: uid('b'), type: 'page', label: book.title, bookId: book.id, pageNumber: page },
    text.trim() ? { id: uid('b'), type: 'quote', content: `“${esc(text.replace(/\s+/g, ' ').slice(0, 900))}” — ${citePage(book.title, page)}` } : null,
    { id: uid('b'), type: 'text', content: '' },
  ].filter(Boolean) as Block[])
  App.emit()
  location.hash = routes.note(subjectId, topic.id, note.id)
  toast('Pagina inserita nell’appunto')
}

async function quickNoteFromPage(book: Book, page: number) {
  const subject = App.subjects[0]
  if (!subject) return toast('Crea prima un soggetto')
  await writePageNote(subject.id, book, page, (await getPage(book.id, page))?.text ?? '', `p. ${page} — ${new Date().toLocaleDateString('it-IT')}`)
}

async function bookMenu(book: Book, index: Bm25 | null) {
  const pages = await pageTexts(book.id)
  const withText = pages.filter((p) => p.text.trim().length > 20).length
  const bytes = await bookBytes(book.id)
  const pct = Math.round((withText / Math.max(1, book.pageCount)) * 100)
  const body = el('div', { class: 'book-info' })
  body.append(
    el('p', { class: 'lede', text: `${book.pageCount} pagine · ${withText} con testo (${pct}%) · ${(bytes / 1e6).toFixed(1)} MB di immagini · origine: ${book.origin}` }),
    el('p', {
      class: 'lede dim',
      text: 'Il testo è ciò che rende il libro cercabile e leggibile dall’AI. Le immagini servono a leggere e a far vedere le figure a un modello con visione. Se la copertura è bassa: importa di nuovo con OCR, o incolla il testo delle pagine che ti servono davvero.',
    }),
    el(
      'div',
      { class: 'row-btns wrap' },
      el('button', {
        class: 'btn small',
        type: 'button',
        text: 'Esporta .md scaricato',
        onclick: async () => {
          const files = await vaultToBookFiles(book)
          downloadText(`${safe(book.title)}.md`, files[0]!.text + '\n\n' + files.slice(1).map((f) => `<!-- ${f.path} -->\n${f.text}`).join('\n\n'))
        },
      }),
      el('button', { class: 'btn small', type: 'button', text: 'Esporta in un folder (OneDrive/Syncthing)', onclick: () => void exportBook(book) }),
      el('button', {
        class: 'btn small',
        type: 'button',
        text: 'Togli solo le immagini',
        onclick: async () => {
          if (!(await confirmDialog(`Togliere le immagini di "${book.title}"? Resta il testo: ricerca e AI funzionano, recuperi spazio.`))) return
          const rows = await db.pages.where('bookId').equals(book.id).toArray()
          for (const r of rows) delete r.image
          await db.pages.bulkPut(rows)
          toast('Immagini rimosse')
          App.emit()
        },
      }),
      el('button', {
        class: 'btn small danger',
        type: 'button',
        text: 'Elimina libro',
        onclick: async () => {
          if (!(await confirmDialog(`Eliminare "${book.title}" e le sue ${book.pageCount} pagine? Gli appunti che le citano restano.`))) return
          await deleteBook(book.id)
          dropIndex(book.id)
          if (index) index = null
          location.hash = book.subjectId ? routes.subject(book.subjectId) : routes.all
          App.emit()
        },
      }),
    ),
  )
  await modal({ title: book.title, subtitle: book.author, body, wide: true, actions: [{ label: 'Chiudi', kind: 'primary', value: 'ok' }] })
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '').slice(0, 60)

async function exportBook(book: Book) {
  try {
    const root = await pickFolder()
    if (!root) return
    if (!(await ensurePermission(root))) return
    const files = await vaultToBookFiles(book)
    const n = await writeFilesToFolder(root, files)
    toast(`${n} file scritti in “${root.name}”`)
  } catch (err) {
    toast(`Esportazione fallita: ${(err as Error).message}`)
  }
}

async function confirmDialog(text: string) {
  const r = await modal({
    title: 'Confermi?',
    subtitle: text,
    actions: [
      { label: 'Annulla', kind: 'ghost', value: '' },
      { label: 'Sì, fallo', kind: 'danger', value: 'ok' },
    ],
  })
  return !!r
}

async function aiSettings(refresh?: () => Promise<unknown>) {
  await aiSettingsModal()
  await Promise.resolve()
    .then(() => refresh?.())
    .catch(() => undefined)
}

