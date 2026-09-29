import {
  listNotes,
  listTopics,
  moveNote,
  setTopicOrder,
  createNote,
} from '../core/db'
import type { Block, Note, Subject, Topic } from '../core/types'
import { fmtRelative, htmlToText } from '../core/util'
import { icons } from './icons'
import { App, routes, type Route } from './state'
import {
  newNote,
  newSubject,
  newTopic,
  relocateTopic,
  removeSubject,
  removeTopic,
  renameSubject,
  renameTopic,
} from './actions'

function h<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...kids: (Node | string | null | undefined)[]): T {
  const node = document.createElement(tag) as T
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.className = String(v)
    else if (k === 'html') node.innerHTML = String(v)
    else if (k === 'text') node.textContent = String(v)
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v as (...a: any[]) => void)
    else node.setAttribute(k, String(v))
  }
  for (const kid of kids) if (kid) node.append(typeof kid === 'string' ? document.createTextNode(kid) : kid)
  return node
}

export const previewOf = (note: Note, limit = 150) => {
  const text = note.blocks
    .filter((b) => b.type !== 'divider' && b.type !== 'image')
    .map((b) => (b.type === 'link' ? `↗ ${b.label ?? b.url}` : htmlToText(b.content ?? '')))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text || 'Empty note'
}

export const blockCountLabel = (blocks: Block[]) => {
  const words = blocks.reduce((n, b) => n + htmlToText(b.content ?? '').split(/\s+/).filter(Boolean).length, 0)
  return `${words} word${words === 1 ? '' : 's'} · ${blocks.length} block${blocks.length === 1 ? '' : 's'}`
}

/* ------------------------------------------------------------- subject tabs */

export function renderTabBar(host: HTMLElement, route: Route) {
  host.replaceChildren()
  const tabs = h('div', { class: 'tabs' })
  const addTab = (label: string, active: boolean, href: string, menu?: (e: MouseEvent) => void, emoji?: string) => {
    const tab = h('a', { class: 'tab' + (active ? ' on' : ''), href, 'aria-current': active ? 'page' : null })
    if (emoji) tab.append(h('span', { class: 'tab-emoji', text: emoji }))
    tab.append(h('span', { class: 'tab-name', text: label }))
    if (menu) tab.append(h('button', { class: 'tab-x', type: 'button', html: icons.dots, title: 'Subject options', onclick: (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); menu(e) } }))
    tabs.append(tab)
  }
  addTab('All', route.view === 'all' || route.view === 'library', routes.all, undefined, '◧')
  for (const s of App.subjects) {
    const active = 'subjectId' in route && route.subjectId === s.id
    addTab(s.name, active, routes.subject(s.id), () => subjectMenu(s), s.emoji)
  }
  tabs.append(h('button', { class: 'tab tab-add', type: 'button', title: 'New subject', html: icons.plus, onclick: () => void newSubject() }))
  host.append(tabs)
  requestAnimationFrame(() => {
    tabs.querySelector<HTMLElement>('.tab.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  })
}

function subjectMenu(s: Subject, anchor?: HTMLElement) {
  const menu = h('div', { class: 'ctx' })
  const item = (label: string, fn: () => void, cls = 'ctx-item') => menu.append(h('button', { class: cls, type: 'button', text: label, onclick: () => { menu.remove(); void fn() } }))
  item('New topic inside', () => void newTopic(s.id))
  item('Rename subject…', () => void renameSubject(s.id))
  item('Add a note to the first topic', async () => {
    const topics = await listTopics(s.id)
    if (!topics.length) {
      const t = await newTopic(s.id)
      if (t) await newNote(t.id, s.id)
      return
    }
    await createNote(topics[0]!.id, 'Untitled')
    App.emit()
    location.hash = routes.topic(s.id, topics[0]!.id)
  })
  menu.append(h('div', { class: 'ctx-sep' }))
  item('Delete subject…', () => void removeSubject(s.id), 'ctx-item danger')
  document.body.append(menu)
  const r = anchor?.getBoundingClientRect() ?? (document.activeElement ?? document.body).getBoundingClientRect()
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 220)}px`
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 240))}px`
  setTimeout(() => document.addEventListener('mousedown', (e) => { if (!menu.contains(e.target as Node)) menu.remove() }, { once: true }), 0)
}

/* ---------------------------------------------------------------- sidebar */

export async function renderSidebar(host: HTMLElement, route: Route) {
  const subjectId = 'subjectId' in route ? route.subjectId : undefined
  const subject = subjectId ? App.subjectById.get(subjectId) : undefined
  host.replaceChildren()

  const top = h('div', { class: 'side-top' })
  top.append(
    h('button', { class: 'side-title', type: 'button', title: 'Show all subjects', onclick: () => (location.hash = routes.all) },
      h('span', { class: 'side-emoji', text: subject?.emoji ?? '◧' }),
      h('span', { text: subject?.name ?? 'All subjects' }),
      h('span', { class: 'ic faint', html: icons.chevronDown })),
  )
  host.append(top)

  const nav = h('div', { class: 'side-scroll' })
  nav.append(
    sideLink('Library of links', icons.link, routes.library('all'), route.view === 'library'),
    sideLine(),
  )

  if (!App.subjects.length) {
    nav.append(h('div', { class: 'side-empty' },
      h('p', { text: 'No subjects yet.' }),
      h('button', { class: 'btn primary small', type: 'button', text: 'New subject', onclick: () => void newSubject() })))
    host.append(nav)
    return
  }

  if (!subject) {
    for (const s of App.subjects) {
      const topics = await listTopics(s.id)
      let notes = 0
      for (const t of topics) notes += (await listNotes(t.id)).length
      nav.append(
        h('button', {
          class: 'side-subject',
          type: 'button',
          onclick: () => (location.hash = routes.subject(s.id)),
        }, h('span', { class: 'side-emoji sm', text: s.emoji }), h('span', { text: s.name }), h('span', { class: 'count', text: String(notes) })),
      )
      void topics
    }
    host.append(nav)
    return
  }

  const topics = await listTopics(subject.id)
  const adder = h('div', { class: 'side-actions' },
    h('button', { class: 'side-add', type: 'button', html: `${icons.plus}<span>New topic</span>`, onclick: () => void newTopic(subject.id) }))
  nav.append(adder)

  if (!topics.length) {
    nav.append(h('p', { class: 'side-hint', text: 'A topic is a chapter or theme. Make one to start putting notes in.' }))
    host.append(nav)
    return
  }

  const list = h('div', { class: 'topic-list' })
  for (const t of topics) {
    list.append(await topicRow(subject, t, route))
  }
  nav.append(list)
  host.append(nav)
}

const sideLine = () => h('div', { class: 'side-line' })
const sideLink = (label: string, ic: string, href: string, active: boolean) =>
  h('a', { class: 'side-link' + (active ? ' on' : ''), href }, h('span', { class: 'ic', html: ic }), h('span', { text: label }))

async function topicRow(subject: Subject, t: Topic, route: Route) {
  const notes = (await listNotes(t.id)).sort((a, b) => b.updatedAt - a.updatedAt)
  const list = h('div', { class: 'note-list' })
  const row = h('div', {
    class: 'trow' + ('topicId' in route && route.topicId === t.id ? ' on' : ''),
    draggable: 'true',
    dataset: { topic: t.id },
  })
  const open = 'topicId' in route && route.topicId === t.id
  row.append(
    h('button', {
      class: 'trow-main',
      type: 'button',
      onclick: () => (location.hash = routes.topic(subject.id, t.id)),
    },
      h('span', { class: 'twist', html: open ? icons.chevronDown : icons.chevron }),
      h('span', { class: 'trow-emoji', text: t.emoji }),
      h('span', { class: 'trow-name', text: t.name }),
      h('span', { class: 'count', text: String(notes.length) })),
    h('span', { class: 'trow-menu' },
      h('button', { class: 'mini', type: 'button', html: icons.plus, title: 'New note', onclick: () => void newNote(t.id, subject.id) }),
      h('button', { class: 'mini', type: 'button', html: icons.dots, title: 'Topic options', onclick: (e: Event) => topicMenu(e.currentTarget as HTMLElement, subject, t) })),
  )
  if (open) {
    const kids = list
    for (const n of notes.slice(0, 60)) {
      kids.append(h('a', {
        class: 'note-link' + (route.view === 'note' && route.noteId === n.id ? ' on' : ''),
        href: routes.note(subject.id, t.id, n.id),
        draggable: 'true',
        dataset: { note: n.id, intoTopic: t.id },
        ondragstart: (e: DragEvent) => e.dataTransfer?.setData('text/note', n.id),
      }, h('span', { class: 'note-dot' }), h('span', { text: n.title })))
    }
    if (!notes.length) kids.append(h('p', { class: 'note-none', text: 'No notes yet' }))
    row.append(kids)
  }
  row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop') })
  row.addEventListener('dragleave', () => row.classList.remove('drop'))
  row.addEventListener('drop', async (e: DragEvent) => {
    e.preventDefault()
    row.classList.remove('drop')
    const noteId = e.dataTransfer?.getData('text/note')
    if (noteId) {
      await moveNote(noteId, t.id)
      App.emit()
      return
    }
    const topicId = e.dataTransfer?.getData('text/topic')
    if (topicId) {
      const ids = Array.from(list.querySelectorAll<HTMLElement>('[data-topic]')).map((n) => n.dataset.topic!).filter(Boolean)
      const from = ids.indexOf(topicId)
      const to = ids.indexOf(t.id)
      if (from >= 0 && to >= 0) {
        ids.splice(to, 0, ...ids.splice(from, 1))
        await setTopicOrder(subject.id, ids)
        App.emit()
      }
    }
  })
  row.addEventListener('dragstart', (e: DragEvent) => e.dataTransfer?.setData('text/topic', t.id))
  return row
}

function topicMenu(anchor: HTMLElement, subject: Subject, t: Topic) {
  const menu = h('div', { class: 'ctx' })
  const item = (label: string, fn: () => void, cls = 'ctx-item') => menu.append(h('button', { class: cls, type: 'button', text: label, onclick: () => { menu.remove(); void fn() } }))
  item('New note here', () => void newNote(t.id, subject.id))
  item('Rename…', () => void renameTopic(t.id))
  item('Move to another subject…', () => void relocateTopic(t.id))
  menu.append(h('div', { class: 'ctx-sep' }))
  item('Delete topic…', () => void removeTopic(t.id), 'ctx-item danger')
  document.body.append(menu)
  const r = anchor.getBoundingClientRect()
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 200)}px`
  menu.style.left = `${Math.max(8, r.left - 120)}px`
  setTimeout(() => document.addEventListener('mousedown', (e) => { if (!menu.contains(e.target as Node)) menu.remove() }, { once: true }), 0)
}

/* --------------------------------------------------------------- all view */

export async function renderAll(host: HTMLElement) {
  const notes = (await Promise.all(App.subjects.map((s) => collectNotes(s)))).flat()
  host.append(
    h('header', { class: 'view-head' },
      h('div', { class: 'view-head-text' },
        h('h1', { text: 'Subjects' }),
        h('p', { class: 'lede', text: `${App.subjects.length} subject${App.subjects.length === 1 ? '' : 's'} · ${notes.length} note${notes.length === 1 ? '' : 's'}. Press ⌘K to jump anywhere.` })),
      h('div', { class: 'view-head-actions' },
        h('button', { class: 'btn primary', type: 'button', html: `${icons.plus}<span>New subject</span>`, onclick: () => void newSubject() }))),
  )
  if (!App.subjects.length) {
    host.append(h('div', { class: 'empty' },
      h('p', { class: 'empty-big', text: 'Nothing here yet' }),
      h('p', { text: 'A subject is the biggest bucket: one per thing you are studying or organising.' }),
      h('button', { class: 'btn primary', type: 'button', text: 'Create your first subject', onclick: () => void newSubject() })))
    return
  }
  const grid = h('div', { class: 'grid' })
  for (const s of App.subjects) {
    const topics = await listTopics(s.id)
    let count = 0
    let latest = 0
    for (const t of topics) {
      const ns = await listNotes(t.id)
      count += ns.length
      latest = Math.max(latest, ...ns.map((n) => n.updatedAt), 0)
    }
    grid.append(
      h('a', { class: `card subj c-${s.color}`, href: routes.subject(s.id) },
        h('div', { class: 'card-top' }, h('span', { class: 'card-emoji', text: s.emoji }), h('span', { class: 'card-meta', text: latest ? fmtRelative(latest) : 'new' })),
        h('h2', { text: s.name }),
        h('p', { class: 'card-sub', text: `${topics.length} topic${topics.length === 1 ? '' : 's'} · ${count} note${count === 1 ? '' : 's'}` }),
        h('div', { class: 'chips' }, ...topics.slice(0, 4).map((t) => h('span', { class: 'chip', text: `${t.emoji} ${t.name}` }))),
        topics.length > 4 ? h('span', { class: 'chip more', text: `+${topics.length - 4}` }) : null),
    )
  }
  host.append(grid)

  const recent = notes.sort((a, b) => b.note.updatedAt - a.note.updatedAt).slice(0, 6)
  if (recent.length) {
    const list = h('div', { class: 'recent' })
    for (const r of recent) {
      list.append(h('a', { class: 'recent-row', href: routes.note(r.subject.id, r.topic.id, r.note.id) },
        h('span', { class: 'recent-icon', text: r.note.icon }),
        h('span', { class: 'recent-txt' }, h('b', { text: r.note.title }), h('span', { class: 'recent-sub', text: `${r.subject.emoji} ${r.subject.name} · ${r.topic.name}` })),
        h('span', { class: 'recent-when', text: fmtRelative(r.note.updatedAt) })))
    }
    host.append(h('section', { class: 'section' }, h('h3', { class: 'section-title', text: 'Recently edited' }), list))
  }
}

export async function collectNotes(subject: Subject) {
  const out: { note: Note; topic: Topic; subject: Subject }[] = []
  for (const t of await listTopics(subject.id)) for (const n of await listNotes(t.id)) out.push({ note: n, topic: t, subject })
  return out
}

/* ----------------------------------------------------------- subject view */

export async function renderSubject(host: HTMLElement, subjectId: string) {
  const subject = App.subjectById.get(subjectId)
  if (!subject) {
    host.append(h('div', { class: 'empty' }, h('p', { class: 'empty-big', text: 'That subject no longer exists' }), h('a', { class: 'btn', href: routes.all, text: 'Back to all subjects' })))
    return
  }
  const topics = await listTopics(subjectId)
  let total = 0
  host.append(
    h('header', { class: 'view-head' },
      h('div', { class: 'view-head-text' },
        h('div', { class: 'kicker' }, h('span', { class: 'kicker-emoji', text: subject.emoji }), h('span', { text: 'Subject' })),
        h('h1', { text: subject.name, class: 'view-title' }),
        h('p', { class: 'lede', text: `${topics.length} topic${topics.length === 1 ? '' : 's'} · click a topic to open its notes` })),
      h('div', { class: 'view-head-actions' },
        h('button', { class: 'btn', type: 'button', html: `${icons.dots}<span>Options</span>`, onclick: (e: MouseEvent) => subjectMenu(subject, e.currentTarget as HTMLElement) }),
        h('button', { class: 'btn primary', type: 'button', html: `${icons.plus}<span>New topic</span>`, onclick: () => void newTopic(subjectId) }))),
  )

  if (!topics.length) {
    host.append(h('div', { class: 'empty' },
      h('p', { class: 'empty-big', text: 'No topics yet' }),
      h('p', { text: 'Topics hold the actual notes — think “chapter”, “module”, “case study”.' }),
      h('button', { class: 'btn primary', type: 'button', text: 'Add a topic', onclick: () => void newTopic(subjectId) })))
    return
  }

  const wrap = h('div', { class: 'topic-grid' })
  for (const t of topics) {
    const notes = (await listNotes(t.id)).sort((a, b) => b.updatedAt - a.updatedAt)
    total += notes.length
    const card = h('section', { class: 'topic-card' },
      h('div', { class: 'topic-card-head' },
        h('a', { class: 'topic-card-title', href: routes.topic(subjectId, t.id) },
          h('span', { class: 'topic-emoji', text: t.emoji }), h('h2', { text: t.name }), h('span', { class: 'ic faint', html: icons.chevron })),
        h('button', { class: 'mini', type: 'button', html: icons.plus, title: 'New note in topic', onclick: () => void newNote(t.id, subjectId) })),
      h('div', { class: 'note-cards' },
        ...(notes.length
          ? notes.slice(0, 12).map((n) => noteCard(subject, t, n))
          : [h('p', { class: 'note-none', text: 'Nothing in here yet' })]),
        notes.length > 12 ? h('a', { class: 'more', href: routes.topic(subjectId, t.id), text: `${notes.length - 12} more` }) : null),
    )
    wrap.append(card)
  }
  host.append(wrap)
  void total
}

export const noteCard = (subject: Subject, topic: Topic, n: Note) =>
  h('a', { class: 'note-card', href: routes.note(subject.id, topic.id, n.id) },
    h('div', { class: 'note-card-top' }, h('span', { class: 'note-card-icon', text: n.icon }), h('span', { class: 'note-card-when', text: fmtRelative(n.updatedAt) })),
    h('h3', { text: n.title }),
    h('p', { class: 'note-card-preview', text: previewOf(n) }),
    n.blocks.some((b) => b.type === 'link')
      ? h('div', { class: 'note-card-links' }, h('span', { class: 'ic', html: icons.link }), h('span', { text: String(n.blocks.filter((b) => b.type === 'link').length) }))
      : null)

/* -------------------------------------------------------------- topic view */

export async function renderTopic(host: HTMLElement, subjectId: string, topicId: string) {
  const subject = App.subjectById.get(subjectId)
  const topic = App.topicById.get(topicId)
  if (!subject || !topic) {
    host.append(h('div', { class: 'empty' }, h('p', { class: 'empty-big', text: 'Topic not found' }), h('a', { class: 'btn', href: routes.all, text: 'Back' })))
    return
  }
  const notes = (await listNotes(topicId)).sort((a, b) => b.updatedAt - a.updatedAt)
  host.append(
    h('nav', { class: 'crumbs' },
      h('a', { href: routes.subject(subjectId), text: `${subject.emoji} ${subject.name}` }),
      h('span', { class: 'ic faint', html: icons.chevron }),
      h('span', { text: topic.name })),
    h('header', { class: 'view-head' },
      h('div', { class: 'view-head-text' },
        h('h1', { class: 'view-title', text: `${topic.emoji} ${topic.name}` }),
        h('p', { class: 'lede', text: `${notes.length} note${notes.length === 1 ? '' : 's'} in this topic` })),
      h('div', { class: 'view-head-actions' },
        h('button', { class: 'btn primary', type: 'button', html: `${icons.plus}<span>New note</span>`, onclick: () => void newNote(topicId, subjectId) }))),
  )
  if (!notes.length) {
    host.append(h('div', { class: 'empty' },
      h('p', { class: 'empty-big', text: 'No notes in this topic' }),
      h('button', { class: 'btn primary', type: 'button', text: 'Write the first one', onclick: () => void newNote(topicId, subjectId) })))
    return
  }
  const grid = h('div', { class: 'note-cards grid-notes' })
  for (const n of notes) grid.append(noteCard(subject, topic, n))
  host.append(grid)
}
