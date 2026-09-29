import { listBooks, listTopics, pageTexts, searchNotes } from '../core/db'
import { Bm25, buildIndex } from '../core/search'
import { openImport } from './books'
import { aiSettingsModal } from './ai-settings'
import { openScanDialog } from './scan'
import { exportToFolder, importFromFolder, newNote, newSubject, newTopic, quickCaptureLink, refreshFromFolder } from './actions'
import { el } from './dom'
import { icon } from './icons'
import { App, routes } from './state'
import { applyTheme, toggleTheme } from './theme'

interface Item {
  label: string
  hint?: string
  group: string
  glyph?: string
  run: () => void
}

/** Page hits across imported books (needs the book text layer; OCR first if empty). */
async function searchBooks(q: string): Promise<Item[]> {
  const books = await listBooks()
  const out: Item[] = []
  for (const book of books) {
    if (out.length >= 6) break
    const idx = buildIndex(await pageTexts(book.id))
    for (const hit of idx.search(q, 3)) {
      out.push({
        label: `${book.title} · p. ${hit.page}`,
        hint: Bm25.snippet(hit.text, q).replace(/\s+/g, ' ').slice(0, 90),
        group: 'Pagine dei libri',
        glyph: `<span class="pal-emoji">📖</span>`,
        run: () => (location.hash = routes.book(book.id, hit.page)),
      })
    }
  }
  return out
}

export async function openPalette(initialQuery = '') {
  const input: HTMLInputElement = el('input', { class: 'pal-input', type: 'text', placeholder: 'Search notes, or run a command…', value: initialQuery, spellcheck: 'false', autocomplete: 'off' })
  const list = el('div', { class: 'pal-list' })
  const box = el('div', { class: 'pal' }, input, list, el('div', { class: 'pal-foot' }, el('span', { html: `${icon('search')} search notes` }), el('span', { text: '↑↓ move · ↵ open · esc close' })))
  const scrim = el('div', { class: 'scrim pal-scrim' }, box)
  let items: Item[] = []
  let active = 0

  const commands = (): Item[] => {
    const base: Item[] = [
      { label: 'New subject', hint: '⌘⇧N', group: 'Create', glyph: icon('plusSquare'), run: () => void newSubject() },
      {
        label: App.route.view === 'note' || App.route.view === 'topic' ? 'New note here' : 'New note in the first topic',
        group: 'Create',
        glyph: icon('plus'),
        run: () => {
          if (App.route.view === 'topic' || App.route.view === 'note') void newNote(App.route.topicId, App.route.subjectId)
          else {
            const s = App.subjects[0]
            if (!s) return void newSubject()
            void (async () => {
              const topics = await listTopics(s.id)
              if (!topics[0]) return void newTopic(s.id)
              void newNote(topics[0].id, s.id)
            })()
          }
        },
      },
      { label: 'Save a link from the clipboard', hint: '⌘⇧L', group: 'Create', glyph: icon('link'), run: () => void quickCaptureLink() },
      { label: 'Link library', group: 'Go to', glyph: icon('link'), run: () => (location.hash = routes.library('all')) },
      { label: 'Testi (libri importati)', group: 'Go to', glyph: icon('book'), run: () => (location.hash = routes.books) },
      { label: 'Import a book', hint: 'EPUB · PDF · immagini', group: 'Create', glyph: icon('upload'), run: () => void openImport() },
      { label: 'Screenshot → appunti', hint: 'le immagini non lasciano il PC', group: 'Create', glyph: icon('image'), run: () => void openScanDialog() },
      { label: 'AI locale: modello, visione, contesto', group: 'App', glyph: icon('menu'), run: () => void aiSettingsModal() },
      { label: 'All subjects', group: 'Go to', glyph: icon('grid'), run: () => (location.hash = routes.all) },
      ...App.subjects.map((s) => ({ label: s.name, hint: 'subject', group: 'Go to', glyph: `<span class="pal-emoji">${s.emoji}</span>`, run: () => (location.hash = routes.subject(s.id)) })),
      { label: document.documentElement.dataset.theme === 'dark' ? 'Light appearance' : 'Dark appearance', group: 'App', glyph: icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'), run: () => void toggleTheme() },
      { label: 'Export notes to a folder', hint: 'Markdown', group: 'Data', glyph: icon('download'), run: () => void exportToFolder() },
      { label: 'Sync with the last folder', group: 'Data', glyph: icon('refresh'), run: () => void refreshFromFolder() },
      { label: 'Import a folder of Markdown', group: 'Data', glyph: icon('upload'), run: () => void importFromFolder() },
    ]
    return base
  }

  const paint = async () => {
    const q = input.value.trim()
    const found = q ? await searchNotes(q) : []
    const bookHits = q ? await searchBooks(q) : []
    const hits: Item[] = found.map((hit) => ({
      label: hit.note.title,
      hint: `${hit.subject.name} › ${hit.topic.name}`,
      group: 'Notes',
      glyph: `<span class="pal-emoji">${hit.note.icon}</span>`,
      run: () => (location.hash = routes.note(hit.subject.id, hit.topic.id, hit.note.id)),
    }))
    const cmds = commands().filter((c) => !q || c.label.toLowerCase().includes(q.toLowerCase()) || c.group.toLowerCase().includes(q.toLowerCase()))
    items = [...hits, ...bookHits, ...cmds]
    active = Math.min(active, Math.max(0, items.length - 1))
    const groups: [string, Item[]][] = []
    for (const it of items) {
      const g = groups.find(([name]) => name === it.group)
      if (g) g[1].push(it)
      else groups.push([it.group, [it]])
    }
    let n = 0
    list.replaceChildren(
      ...groups.map(([group, its]) =>
        el('div', { class: 'pal-group' }, el('span', { class: 'pal-group-name', text: group }), ...its.map((it) => {
          const idx = n++
          return el(
            'button',
            {
              class: 'pal-item' + (idx === active ? ' on' : ''),
              type: 'button',
              dataset: { idx: String(idx) },
              onmouseenter: (e: Event) => {
                setActive((e.currentTarget as HTMLElement).dataset.idx ? Number((e.currentTarget as HTMLElement).dataset.idx) : idx)
              },
              onclick: () => {
                close()
                it.run()
              },
            },
            el('span', { class: 'pal-glyph', html: it.glyph ?? icon('book') }),
            el('span', { class: 'pal-txt' }, el('b', { text: it.label }), it.hint ? el('span', { class: 'pal-hint', text: it.hint }) : null),
            el('span', { class: 'pal-kbd' + (it.label === found[0]?.note.title ? ' hide' : '') }),
          )
        })),
      ),
    )
    if (!items.length) list.replaceChildren(el('p', { class: 'pal-none', text: q ? `Nothing matches “${q}”.` : 'Start typing to search your notes.' }))
  }

  const setActive = (i: number) => {
    active = i
    list.querySelectorAll('.pal-item').forEach((n) => n.classList.toggle('on', Number((n as HTMLElement).dataset.idx) === i))
    list.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' })
  }

  const close = () => {
    scrim.classList.add('closing')
    setTimeout(() => scrim.remove(), 120)
    document.removeEventListener('keydown', onKey, true)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((active + 1) % Math.max(1, items.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((active - 1 + items.length) % Math.max(1, items.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = items[active]
      if (it) {
        close()
        it.run()
      }
    }
  }
  document.addEventListener('keydown', onKey, true)
  input.addEventListener('input', () => {
    active = 0
    void paint()
  })
  document.body.append(scrim)
  scrim.addEventListener('pointerdown', (e) => {
    if (e.target === scrim) close()
  })
  input.focus()
  void paint()
  void applyTheme
}
