import {
  createNote,
  getNote,
  listRevisions,
  patchLink,
  restoreRevision,
  saveBlocks,
  snapshot,
  touchNote,
} from '../core/db'
import { noteToMd } from '../core/md'
import type { Block, Note } from '../core/types'
import { fmtDate, fmtRelative } from '../core/util'
import { mountEditor, type EditorHandle } from '../editor/editor'
import { addLinkToNote, removeNote, relocateNote } from './actions'
import { EMOJIS, confirmDialog, el, toast } from './dom'
import { icons } from './icons'
import { App, routes } from './state'
import { blockCountLabel } from './views'

export async function renderNote(host: HTMLElement, noteId: string, signal: AbortSignal) {
  const note = await getNote(noteId)
  if (!note) {
    host.replaceChildren(
      el('div', { class: 'empty' }, el('p', { class: 'empty-big', text: 'That note is gone' }), el('a', { class: 'btn', href: routes.all, text: 'Back to subjects' })),
    )
    return
  }
  const topic = App.topicById.get(note.topicId)
  const subject = topic ? App.subjectById.get(topic.subjectId) : undefined

  const wrap = el('article', { class: 'note', dataset: { note: noteId } })
  wrap.append(
    el(
      'nav',
      { class: 'crumbs' },
      subject ? el('a', { href: routes.subject(subject.id), text: `${subject.emoji} ${subject.name}` }) : null,
      subject ? el('span', { class: 'ic faint', html: icons.chevron }) : null,
      topic ? el('a', { href: routes.topic(subject?.id ?? '', topic.id), text: `${topic.emoji} ${topic.name}` }) : null,
    ),
  )

  const iconBtn = el('button', { class: 'note-icon', type: 'button', text: note.icon || '📝', title: 'Change icon' })
  iconBtn.addEventListener('click', () => pickIcon(iconBtn, note))

  const title = el('h1', {
    class: 'note-title',
    contenteditable: 'true',
    spellcheck: 'true',
    'data-placeholder': note.title === 'Untitled' ? 'Untitled' : '',
  })
  title.textContent = note.title === 'Untitled' ? '' : note.title
  const syncTitle = () => {
    const text = (title.textContent ?? '').replace(/\s+/g, ' ').trim()
    void touchNote(noteId, { title: text || 'Untitled' }).then(() => App.emit())
  }
  title.addEventListener('blur', syncTitle)
  title.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      syncTitle()
      const first = document.querySelector<HTMLElement>('.brow [contenteditable="true"]')
      title.blur()
      first?.focus()
    }
    if (e.key === 'Escape') title.blur()
  })

  const when = el('span', { class: 'note-count', text: `${blockCountLabel(note.blocks)} · edited ${fmtRelative(note.updatedAt)}` })
  const saveState = el('span', { class: 'save-state', dataset: { state: 'saved' }, text: 'Saved' })
  const meta = el(
    'div',
    { class: 'note-meta' },
    when,
    saveState,
    el('button', { class: 'mini', type: 'button', html: icons.history, title: 'Version history', onclick: () => void historyModal(noteId) }),
    el('button', { class: 'mini', type: 'button', html: icons.dots, title: 'Note options', onclick: (e: Event) => noteMenu(e.currentTarget as HTMLElement, note) }),
  )
  wrap.append(el('header', { class: 'note-head' }, el('div', { class: 'note-head-top' }, iconBtn, title), meta))

  const editorHost = el('div', { class: 'blocks' })
  wrap.append(editorHost)

  const refs = el('aside', { class: 'refs' })
  const paintRefs = (blocks: Block[]) => {
    const links = blocks.filter((b) => b.type === 'link')
    const box = el('div', { class: 'refs-inner' })
    if (links.length) {
      box.append(
        el('h2', { class: 'refs-title', text: `References · ${links.length}` }),
        el(
          'ul',
          { class: 'refs-list' },
          ...links.map((b) =>
            el(
              'li',
              { class: 'ref' },
              el(
                'a',
                { href: b.url ?? '#', target: '_blank', rel: 'noopener noreferrer', class: 'ref-link' },
                el('span', { class: `badge b-${b.kind ?? 'link'}`, text: b.kind ?? 'link' }),
                el('span', { text: b.label || b.url || '' }),
              ),
              b.note ? el('span', { class: 'ref-note', text: b.note }) : null,
              el('button', {
                class: 'mini' + (b.read ? ' on' : ''),
                type: 'button',
                html: b.read ? icons.check : icons.clock,
                title: b.read ? 'Marked as read / watched — click to revisit' : 'Mark as read / watched',
                onclick: () => void toggleRead(noteId, b.id, !b.read),
              }),
            ),
          ),
        ),
      )
    } else {
      box.append(el('h2', { class: 'refs-title faint', text: 'References' }), el('p', { class: 'refs-hint', text: 'No videos or articles saved in this note yet.' }))
    }
    box.append(
      el('button', {
        class: 'btn ghost small add-link',
        type: 'button',
        html: `${icons.plus}<span>Add a video or article</span>`,
        onclick: () => void addLinkToNote(noteId).then(async () => {
          const fresh = await getNote(noteId)
          if (fresh) {
            editor.replaceBlocks(fresh.blocks)
            paintRefs(fresh.blocks)
          }
        }),
      }),
    )
    refs.replaceChildren(box)
  }
  paintRefs(note.blocks)
  wrap.append(refs)

  host.replaceChildren(wrap)

  let editor: EditorHandle
  editor = mountEditor(editorHost, note, (blocks) => {
    void saveBlocks(noteId, blocks).then(async () => {
      saveState.dataset.state = 'saved'
      const fresh = await getNote(noteId)
      if (fresh) {
        when.textContent = `${blockCountLabel(blocks)} · edited ${fmtRelative(fresh.updatedAt)}`
        await snapshot(fresh)
      }
      paintRefs(blocks)
    })
  })

  const onChange = (e: Event) => {
    if ((e as CustomEvent).detail !== noteId) return
    void getNote(noteId).then((fresh) => {
      if (!fresh) return
      editor.replaceBlocks(fresh.blocks)
      paintRefs(fresh.blocks)
    })
  }
  document.addEventListener('note-changed', onChange, { signal })

  // Save whatever is typed before the view is thrown away.
  signal.addEventListener('abort', () => void editor.flush())
  window.addEventListener('blur', () => void editor.flush(), { signal })
  document.addEventListener('visibilitychange', () => void editor.flush(), { signal })
}

async function toggleRead(noteId: string, blockId: string, read: boolean) {
  await patchLink(noteId, blockId, { read })
  App.emit()
  document.dispatchEvent(new CustomEvent('note-changed', { detail: noteId }))
}

/** Emoji popover for the note icon. */
function pickIcon(anchor: HTMLElement, note: Note) {
  const pop = el('div', { class: 'popover emoji-pop' })
  for (const e of EMOJIS) {
    pop.append(
      el('button', {
        class: 'emoji' + (e === note.icon ? ' on' : ''),
        type: 'button',
        text: e,
        onclick: () => {
          void touchNote(note.id, { icon: e }).then(() => {
            note.icon = e
            anchor.textContent = e
            App.emit()
          })
          close()
        },
      }),
    )
  }
  const scrim = el('div', { class: 'popover-scrim' }, pop)
  const close = () => scrim.remove()
  scrim.addEventListener('pointerdown', (e) => {
    if (e.target === scrim) close()
  })
  document.body.append(scrim)
  const r = anchor.getBoundingClientRect()
  pop.style.top = `${r.bottom + 6}px`
  pop.style.left = `${Math.max(10, Math.min(r.left, window.innerWidth - 330))}px`
}

function noteMenu(anchor: HTMLElement, note: Note) {
  const menu = el('div', { class: 'ctx' })
  const item = (label: string, fn: () => void, cls = 'ctx-item') =>
    menu.append(el('button', { class: cls, type: 'button', text: label, onclick: () => { menu.remove(); void fn() } }))
  item('Move to another topic…', () => void relocateNote(note.id))
  item('Duplicate note', async () => {
    const copy = await createNote(
      note.topicId,
      `${note.title} (copy)`,
      note.blocks.map((b) => ({ ...b, id: `${b.id}_c${Math.random().toString(36).slice(2, 6)}` })),
      note.icon,
    )
    App.emit()
    location.hash = routes.note(App.topicById.get(note.topicId)?.subjectId ?? '', note.topicId, copy.id)
  })
  item('Copy as Markdown', async () => {
    await navigator.clipboard?.writeText(`# ${note.title}\n\n${noteToMd(note)}`)
    toast('Markdown copied')
  })
  menu.append(el('div', { class: 'ctx-sep' }))
  item('Delete note…', async () => {
    if (await confirmDialog(`Delete “${note.title}”?`, 'It is removed from this device. Copies already exported to your folder stay untouched.')) await removeNote(note.id)
  }, 'ctx-item danger')
  document.body.append(menu)
  const r = anchor.getBoundingClientRect()
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 240)}px`
  menu.style.left = `${Math.max(8, Math.min(r.left - 140, window.innerWidth - 260))}px`
  setTimeout(() => document.addEventListener('mousedown', (e) => { if (!menu.contains(e.target as Node)) menu.remove() }, { once: true }), 0)
}

async function historyModal(noteId: string) {
  const revs = await listRevisions(noteId)
  const body = el('div', { class: 'revisions' })
  if (!revs.length) body.append(el('p', { class: 'lede', text: 'No snapshots yet — the app keeps up to 25 while you edit a note.' }))
  for (const r of revs.slice(0, 12)) {
    const parsed = JSON.parse(r.json) as { title: string; blocks: Block[] }
    body.append(
      el(
        'div',
        { class: 'rev' },
        el(
          'div',
          { class: 'rev-txt' },
          el('b', { text: fmtDate(r.at) }),
          el('span', { class: 'rev-sub', text: `${parsed.blocks.length} blocks · ${parsed.title}` }),
        ),
        el('button', {
          class: 'btn small',
          type: 'button',
          text: 'Restore',
          onclick: async () => {
            await restoreRevision(r)
            toast('Version restored')
            document.dispatchEvent(new CustomEvent('note-changed', { detail: noteId }))
            App.emit()
            scrim.remove()
          },
        }),
      ),
    )
  }
  const scrim = el(
    'div',
    { class: 'scrim' },
    el(
      'div',
      { class: 'modal wide' },
      el('header', {}, el('h2', { text: 'Version history' }), el('p', { class: 'sub', text: 'Automatic snapshots taken while you type. Nothing leaves your device.' })),
      body,
      el('footer', {}, el('button', { class: 'btn ghost', type: 'button', text: 'Close', onclick: () => scrim.remove() })),
    ),
  )
  document.body.append(scrim)
  scrim.addEventListener('pointerdown', (e) => {
    if (e.target === scrim) scrim.remove()
  })
}
