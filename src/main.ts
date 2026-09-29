import './styles.css'
import { listAllNotes, listAllTopics, listSubjects, seedIfEmpty, getSettings, setSettings } from './core/db'
import { renderSidebar, renderAll, renderSubject, renderTabBar, renderTopic } from './ui/views'
import { renderLibrary } from './ui/library'
import { openImport, renderBooks } from './ui/books'
import { openScanDialog } from './ui/scan'
import { closeReader, patchReader, renderReader } from './ui/reader'
import { listBooks } from './core/db'
import { renderNote } from './ui/note'
import { buildShell, routeTitle } from './ui/shell'
import { el } from './ui/dom'
import { App, parseHash, routes, type Route } from './ui/state'
import { initTheme } from './ui/theme'
import { openPalette } from './ui/palette'
import { exportToFolder, newSubject, quickCaptureLink } from './ui/actions'

let shell: ReturnType<typeof buildShell> | null = null
let controller: AbortController | null = null

async function loadCaches() {
  const [subjects, books] = await Promise.all([listSubjects(), listBooks()])
  App.books = books
  App.bookById = new Map(books.map((x) => [x.id, x]))
  App.subjects = subjects
  App.subjectById = new Map(subjects.map((s) => [s.id, s]))
  const topics = await listAllTopics()
  App.topicById = new Map(topics.map((t) => [t.id, t]))
  const notes = await listAllNotes()
  App.noteById = new Map(notes.map((n) => [n.id, n]))
}

function routeHash(r: Route): string {
  if (r.view === 'books') return routes.books
  if (r.view === 'book') return routes.book(r.bookId, r.page)
  if (r.view === 'all') return routes.all
  if (r.view === 'library') return routes.library(r.filter)
  if (r.view === 'subject') return routes.subject(r.subjectId)
  if (r.view === 'topic') return routes.topic(r.subjectId, r.topicId)
  return routes.note(r.subjectId, r.topicId, r.noteId)
}

async function render() {
  if (!shell) return
  const route = parseHash()
  const isSameRoute = App.route.view === route.view && routeHash(App.route) === routeHash(route)
  // turning a page must not rebuild the reader: it only moves the page
  if (route.view === 'book' && App.route.view === 'book' && route.bookId === App.route.bookId && !isSameRoute) {
    App.route = route
    if (patchReader(route.bookId, route.page)) return
  }
  App.route = route
  if (route.view !== 'book') closeReader()

  controller?.abort()
  const next = new AbortController()
  controller = next

  await loadCaches()

  // A note that no longer exists should not strand the user on a blank screen.
  if (route.view === 'note' && !App.noteById.get(route.noteId)) {
    const fallback = App.topicById.get(route.topicId)
    location.hash = fallback ? routes.topic(fallback.subjectId, fallback.id) : routes.all
    return
  }
  if (route.view === 'subject' && !App.subjectById.get(route.subjectId)) {
    location.hash = routes.all
    return
  }

  renderTabBar(shell.tabs, route)
  await renderSidebar(shell.sidebar, route)

  const view = shell.view
  if (!isSameRoute) view.scrollTop = 0
  view.replaceChildren()
  document.title = routeTitle(route)

  try {
    if (route.view === 'all') await renderAll(view)
    else if (route.view === 'books') await renderBooks(view)
    else if (route.view === 'book') await renderReader(view, route.bookId, route.page, next.signal)
    else if (route.view === 'library') await renderLibrary(view, route.filter ?? 'all')
    else if (route.view === 'subject') await renderSubject(view, route.subjectId)
    else if (route.view === 'topic') await renderTopic(view, route.subjectId, route.topicId)
    else await renderNote(view, route.noteId, next.signal)
  } catch (err) {
    console.error(err)
    view.replaceChildren(
      el('div', { class: 'empty' },
        el('p', { class: 'empty-big', text: 'This view could not be drawn' }),
        el('p', { text: String((err as Error)?.message ?? err) }),
        el('button', { class: 'btn', type: 'button', text: 'Reload', onclick: () => location.reload() })),
    )
  }
}

function bindShortcuts() {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    const typing = (e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable="true"]')
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      void openPalette('')
      return
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      void quickCaptureLink()
      return
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void openScanDialog()
      return
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault()
      void openImport()
      return
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      void newSubject()
      return
    }
    if (mod && e.key.toLowerCase() === 'e' && !typing) {
      e.preventDefault()
      void exportToFolder()
      return
    }
    if (e.key === '/' && !typing && !mod) {
      const first = document.querySelector<HTMLElement>('.brow [contenteditable="true"]')
      if (first) {
        e.preventDefault()
        first.focus()
        document.getSelection()?.selectAllChildren(first)
        document.getSelection()?.collapseToEnd()
      }
      return
    }
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) shell?.setSidebarOpen(false)
  })
  document.addEventListener('open-palette', () => void openPalette(''))
}

async function boot() {
  await initTheme()
  await seedIfEmpty()
  await loadCaches()
  shell = buildShell(document.getElementById('app')!, () => shell?.setSidebarOpen(!document.body.classList.contains('drawer-open')))
  bindShortcuts()
  const settings = await getSettings()
  if (!location.hash && settings.lastRoute) location.hash = settings.lastRoute
  window.addEventListener('hashchange', () => {
    const r = parseHash()
    void getSettings().then((s) => setSettings({ ...s, lastRoute: routeHash(r) }))
    void render()
  })
  App.onChange(() => void render())
  await render()
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    await navigator.serviceWorker.register('./sw.js').catch(() => undefined)
  }
  document.documentElement.classList.add('ready')
}

void boot()
