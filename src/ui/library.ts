import { allLinks, patchLink, type LibraryEntry } from '../core/db'
import { faviconUrl } from '../core/fs'
import { fmtDate, fmtRelative } from '../core/util'
import { el } from './dom'
import { icons } from './icons'
import { App, routes } from './state'

const FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'video', label: 'Videos' },
  { key: 'article', label: 'Articles & reading' },
  { key: 'unread', label: 'To watch / read' },
  { key: 'starred', label: 'Starred' },
]

const matches = (e: LibraryEntry, f: string) =>
  f === 'all'
    ? true
    : f === 'unread'
      ? !e.block.read
      : f === 'starred'
        ? !!e.block.starred
        : (e.block.kind ?? 'link') === f

export async function renderLibrary(host: HTMLElement, filter = 'all') {
  const entries = (await allLinks()).filter((e) => matches(e, filter))
  const all = await allLinks()

  host.append(
    el(
      'header',
      { class: 'view-head' },
      el(
        'div',
        { class: 'view-head-text' },
        el('div', { class: 'kicker' }, el('span', { class: 'kicker-emoji', text: '🔗' }), el('span', { text: 'Library' })),
        el('h1', { class: 'view-title', text: 'Links' }),
        el('p', {
          class: 'lede',
          text: `${all.length} saved across every note — ${all.filter((a) => a.block.kind === 'video').length} videos, ${
            all.filter((a) => a.block.kind !== 'video').length
          } reads.`,
        }),
      ),
      el('a', { class: 'btn', href: routes.all, html: `${icons.book}<span>Back to subjects</span>` }),
    ),
  )

  const bar = el('div', { class: 'filterbar' })
  for (const f of FILTERS) {
    const count = all.filter((a) => matches(a, f.key)).length
    bar.append(
      el('button', {
        class: 'filter' + (f.key === filter ? ' on' : ''),
        type: 'button',
        onclick: () => (location.hash = routes.library(f.key)),
        text: `${f.label}${count ? ` · ${count}` : ''}`,
      }),
    )
  }
  host.append(bar)

  if (!entries.length) {
    host.append(
      el(
        'div',
        { class: 'empty' },
        el('p', { class: 'empty-big', text: filter === 'all' ? 'No links yet' : 'Nothing in this filter' }),
        el('p', { text: 'Open any note, press / and choose “Link to video / article”. Saved links show up here.' }),
      ),
    )
    return
  }

  const list = el('div', { class: 'links' })
  for (const e of entries) {
    const row = el('div', { class: 'link-row' })
    row.append(
      el('img', {
        class: 'favicon lg',
        src: faviconUrl(new URL(e.block.url ?? 'https://example.com').hostname),
        alt: '',
        loading: 'lazy',
        onerror: (ev: Event) => ((ev.target as HTMLImageElement).style.opacity = '0'),
      }),
      el(
        'div',
        { class: 'link-main' },
        el('a', { class: 'link-title', href: e.block.url, target: '_blank', rel: 'noopener noreferrer', text: e.block.label || e.block.url || 'untitled' }),
        el(
          'div',
          { class: 'link-sub' },
          el('span', { class: `badge b-${e.block.kind ?? 'link'}`, text: e.block.kind ?? 'link' }),
          el('span', { class: 'link-where', text: `${e.subject.emoji} ${e.subject.name} › ${e.topic.name} › ${e.note.title}` }),
          e.block.addedAt ? el('span', { class: 'link-when', text: `saved ${fmtDate(e.block.addedAt)}` }) : null,
        ),
        e.block.note ? el('p', { class: 'link-note', text: e.block.note }) : null,
      ),
      el(
        'div',
        { class: 'link-actions' },
        el('button', {
          class: 'mini' + (e.block.starred ? ' on' : ''),
          type: 'button',
          html: icons.star,
          title: 'Star',
          onclick: () => void patchLink(e.note.id, e.block.id, { starred: !e.block.starred }).then(() => App.emit()),
        }),
        el('button', {
          class: 'mini' + (e.block.read ? ' on' : ''),
          type: 'button',
          html: e.block.read ? icons.check : icons.clock,
          title: 'Mark read / watched',
          onclick: () => void patchLink(e.note.id, e.block.id, { read: !e.block.read }).then(() => App.emit()),
        }),
        el('a', { class: 'mini', href: routes.note(e.subject.id, e.topic.id, e.note.id), title: 'Open the note', html: icons.book }),
        el('a', { class: 'btn small', href: e.block.url, target: '_blank', rel: 'noopener noreferrer', html: `${icons.external}<span>Open</span>` }),
      ),
    )
    list.append(row)
  }
  host.append(list)
  void fmtRelative
}
