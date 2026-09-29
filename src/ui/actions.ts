import {
  createNote,
  createSubject,
  createTopic,
  deleteNote,
  deleteSubject,
  deleteTopic,
  exportVault,
  getNote,
  listNotes,
  listTopics,
  mergeVault,
  moveNote,
  moveTopic,
  replaceVault,
  updateSubject,
  updateTopic,
} from '../core/db'
import { downloadText, canPickFolder, ensurePermission, loadFolderHandle, pickFolder, pickFolderWithInput, readFolderAsTree, writeFilesToFolder } from '../core/fs'
import { treeToVault, vaultToFiles } from '../core/md'
import { defaultLabelForUrl, linkInfo } from '../core/fs'
import { safeUrl } from '../core/util'
import { saveBlocks } from '../core/db'
import type { Vault } from '../core/types'
import type { Subject } from '../core/types'
import { confirmDialog, modal, toast } from './dom'
import { uid } from '../core/util'
import { App, routes } from './state'

/** Every mutation goes through here, so saving + re-rendering stays consistent. */
const refresh = () => App.emit()

export async function newSubject(preset?: Partial<Subject>) {
  const res = await modal({
    title: 'New subject',
    subtitle: 'The big tab at the top. One per field you are studying.',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'e.g. Organic Chemistry' },
      { name: 'emoji', label: 'Icon', placeholder: '🧪', value: preset?.emoji ?? '' },
    ],
    actions: [
      { label: 'Cancel', kind: 'ghost', value: '' },
      { label: 'Create', kind: 'primary', value: 'ok' },
    ],
  })
  if (!res?.name) return null
  const subject = await createSubject(res.name, res.emoji?.trim() || '📚', preset?.color ?? 'graphite')
  const topic = await createTopic(subject.id, 'Getting started')
  await createNote(topic.id, 'First note')
  refresh()
  location.hash = routes.subject(subject.id)
  toast('Subject created')
  return subject
}

export async function newTopic(subjectId: string) {
  const res = await modal({
    title: 'New topic',
    subtitle: 'A chapter, module or theme inside the subject.',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'e.g. Enzyme kinetics' },
      { name: 'emoji', label: 'Icon', placeholder: '🧩', value: '' },
    ],
    actions: [
      { label: 'Cancel', kind: 'ghost', value: '' },
      { label: 'Create', kind: 'primary', value: 'ok' },
    ],
  })
  if (!res?.name) return null
  const topic = await createTopic(subjectId, res.name, res.emoji?.trim() || '📄')
  refresh()
  location.hash = routes.topic(subjectId, topic.id)
  return topic
}

export async function newNote(topicId: string, subjectId?: string, title = 'Untitled') {
  const note = await createNote(topicId, title)
  refresh()
  if (subjectId) location.hash = routes.note(subjectId, topicId, note.id)
  setTimeout(() => {
    const t = document.querySelector<HTMLElement>('.note-title')
    t?.focus()
    document.execCommand?.('selectAll', false)
  }, 60)
  return note
}

export async function renameSubject(id: string) {
  const subject = App.subjectById.get(id)
  const res = await modal({
    title: 'Rename subject',
    fields: [
      { name: 'name', label: 'Name', value: subject?.name ?? '' },
      { name: 'emoji', label: 'Icon', value: subject?.emoji ?? '' },
    ],
  })
  if (!res?.name) return
  await updateSubject(id, { name: res.name, emoji: res.emoji?.trim() || subject?.emoji || '📚' })
  refresh()
}

export async function renameTopic(id: string) {
  const topic = App.topicById.get(id)
  const res = await modal({
    title: 'Rename topic',
    fields: [
      { name: 'name', label: 'Name', value: topic?.name ?? '' },
      { name: 'emoji', label: 'Icon', value: topic?.emoji ?? '' },
    ],
  })
  if (!res?.name) return
  await updateTopic(id, { name: res.name, emoji: res.emoji?.trim() || topic?.emoji || '📄' })
  refresh()
}

export async function removeSubject(id: string) {
  const subject = App.subjectById.get(id)
  const topics = await listTopics(id)
  let notes = 0
  for (const t of topics) notes += (await listNotes(t.id)).length
  if (!(await confirmDialog(`Delete “${subject?.name}”?`, `${topics.length} topics and ${notes} notes go with it. Export first if you want a copy.`))) return
  await deleteSubject(id)
  refresh()
  location.hash = routes.all
  toast('Subject deleted', { label: 'Undo', run: async () => { /* vault import is the undo path */ toast('Use Import to restore from your exported folder') } })
}

export async function removeTopic(id: string) {
  const topic = App.topicById.get(id)
  const count = (await listNotes(id)).length
  if (!(await confirmDialog(`Delete “${topic?.name}”?`, `${count} notes go with it.`))) return
  await deleteTopic(id)
  refresh()
  if (App.route.view === 'topic' || App.route.view === 'note') location.hash = routes.subject(topic!.subjectId)
}

export async function removeNote(id: string) {
  const note = App.noteById.get(id)
  if (!note) return
  const parentTopic = note.topicId
  const restoredBlocks = note.blocks
  const restoredTitle = note.title
  await deleteNote(id)
  refresh()
  location.hash = routes.subject(App.topicById.get(parentTopic)?.subjectId ?? '')
  toast('Note deleted', {
    label: 'Undo',
    run: async () => {
      await createNote(parentTopic, restoredTitle, restoredBlocks, note.icon)
      refresh()
    },
  })
}

/** Adds a link card to the end of a note (used by the References panel and ⌘⇧L). */
export async function addLinkToNote(noteId: string) {
  const res = await modal({
    title: 'Add a link to this note',
    subtitle: 'Videos get an inline player; everything else becomes a tidy card.',
    fields: [
      { name: 'url', label: 'Link', placeholder: 'https://youtube.com/watch?v=…' },
      { name: 'label', label: 'Title', placeholder: 'Optional — taken from the link' },
      { name: 'note', label: 'Your note about it', placeholder: 'What to look for, why it matters' },
    ],
    actions: [
      { label: 'Cancel', kind: 'ghost', value: '' },
      { label: 'Add link', kind: 'primary', value: 'ok' },
    ],
  })
  if (!res?.url) return null
  const info = linkInfo(res.url)
  const note = await getNote(noteId)
  if (!note) return null
  const block = {
    id: uid('b'),
    type: 'link' as const,
    url: safeUrl(res.url),
    label: res.label?.trim() || defaultLabelForUrl(res.url),
    note: res.note?.trim() || undefined,
    kind: info.kind,
    embed: info.kind === 'video',
    addedAt: Date.now(),
  }
  await saveBlocks(noteId, [...note.blocks, block])
  refresh()
  document.dispatchEvent(new CustomEvent('note-changed', { detail: noteId }))
  toast('Link added')
  return block
}

/** ⌘⇧L quick capture: drop a link into the note you are reading, else into the last topic. */
export async function quickCaptureLink() {
  const clip = await navigator.clipboard?.readText?.().catch(() => '')
  const res = await modal({
    title: 'Save a link',
    subtitle: 'Paste the URL. It becomes a card you can star, mark as read, and annotate.',
    fields: [
      { name: 'url', label: 'Link', value: clip?.startsWith('http') ? clip : '' , placeholder: 'https://…' },
      { name: 'where', label: 'Into which subject', placeholder: App.subjects[0]?.name ?? 'First subject' },
    ],
    actions: [
      { label: 'Cancel', kind: 'ghost', value: '' },
      { label: 'Save link', kind: 'primary', value: 'ok' },
    ],
  })
  if (!res?.url) return
  const wanted = (res.where ?? '').trim().toLowerCase()
  const subject = App.subjects.find((s) => s.name.toLowerCase() === wanted) ?? App.subjects.find((s) => s.name.toLowerCase().includes(wanted)) ?? App.subjects[0]
  if (!subject) {
    toast('Create a subject first')
    return
  }
  const topics = await listTopics(subject.id)
  const topic = topics[0] ?? (await createTopic(subject.id, 'Collected links'))
  const info = linkInfo(res.url)
  const note = await createNote(topic.id, 'Links')
  await saveBlocks(note.id, [
    ...note.blocks,
    {
      id: uid('b'),
      type: 'link' as const,
      url: safeUrl(res.url),
      label: defaultLabelForUrl(res.url),
      kind: info.kind,
      embed: info.kind === 'video',
      addedAt: Date.now(),
    },
  ])
  refresh()
  location.hash = routes.note(subject.id, topic.id, note.id)
  toast('Saved')
}

/** Move a note to another topic (drag in the sidebar, or from the note menu). */
export async function relocateNote(noteId: string) {
  const note = App.noteById.get(noteId)
  const current = App.topicById.get(note?.topicId ?? '')
  const subjects = App.subjects
  const body = document.createElement('div')
  body.className = 'picker'
  const selected = { topicId: current?.id ?? '' }
  const list = document.createElement('div')
  body.append(list)
  const paint = async () => {
    list.replaceChildren()
    for (const s of subjects) {
      list.append(Object.assign(document.createElement('div'), { className: 'picker-head', textContent: `${s.emoji} ${s.name}` }))
      for (const t of await listTopics(s.id)) {
        const btn = Object.assign(document.createElement('button'), {
          type: 'button',
          className: 'picker-item' + (t.id === selected.topicId ? ' on' : ''),
          textContent: `${t.emoji} ${t.name}`,
        })
        btn.addEventListener('click', () => {
          selected.topicId = t.id
          list.querySelectorAll('.picker-item').forEach((n) => n.classList.remove('on'))
          btn.classList.add('on')
        })
        list.append(btn)
      }
    }
  }
  await paint()
  const res = await modal({ title: 'Move note to…', wide: true, body })
  if (!res) return
  await moveNote(noteId, selected.topicId)
  const subjectId = App.topicById.get(selected.topicId)?.subjectId ?? (App.route.view === 'note' ? App.route.subjectId : '')
  refresh()
  location.hash = routes.note(subjectId, selected.topicId, noteId)
  toast('Moved')
}

export async function relocateTopic(topicId: string) {
  const topic = App.topicById.get(topicId)
  if (!topic) return
  const res = await modal({
    title: 'Move topic to another subject',
    subtitle: 'Type the destination subject name.',
    fields: [{ name: 'subject', label: 'Subject', placeholder: App.subjects.map((s) => s.name).join(' / ') }],
  })
  if (!res?.subject) return
  const target = App.subjects.find((s) => s.name.toLowerCase() === res.subject!.trim().toLowerCase())
  if (!target) {
    toast('No subject with that name')
    return
  }
  await moveTopic(topicId, target.id, (await listTopics(target.id)).length)
  refresh()
  location.hash = routes.topic(target.id, topicId)
  toast(`Moved to ${target.name}`)
}

/* ------------------------------------------------------------------ backup */

export async function exportToFolder() {
  const vault = await exportVault()
  const files = vaultToFiles(vault)
  let root = await loadFolderHandle()
  if (canPickFolder() && !root) {
    root = await pickFolder()
  }
  if (root) {
    if (!(await ensurePermission(root))) {
      toast('Permission denied — pick the folder again')
      return
    }
    const written = await writeFilesToFolder(root, files)
    await writeFilesToFolder(root, [{ path: 'README.txt', text: readmeForVault(vault) }])
    refresh()
    toast(`${written} files written to “${root.name}”`)
    return
  }
  downloadText('notes-export.json', JSON.stringify(vault, null, 2))
  toast('This browser cannot write to a folder — the JSON backup was downloaded instead')
}

export async function exportBackup() {
  const vault = await exportVault()
  const md = vaultToFiles(vault)
  const bundle = { vault, files: md.map((f) => f.path), note: 'Files here are also in vault.notes; convert with a markdown editor if needed.' }
  downloadText(`notes-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(bundle, null, 2))
  toast('Backup downloaded')
}

export async function importFromFolder(mode?: 'replace' | 'merge') {
  let tree
  let files
  const handle = canPickFolder() ? await pickFolder() : null
  if (handle) {
    if (!(await ensurePermission(handle))) return
    const out = await readFolderAsTree(handle)
    tree = out.tree
    files = out.files
  } else {
    const out = await pickFolderWithInput()
    if (!out) return
    tree = out.tree
    files = out.files
  }
  if (!tree.subjects.length) {
    const json = files?.get('notes.vault.json') ?? files?.get('notes-backup.json')
    if (json) {
      const vault = JSON.parse(json) as Vault
      const added = await mergeVault(vault)
      refresh()
      toast(`Imported ${added} notes from JSON`)
      return
    }
    toast('No subject/topic/note folders found — expected Subject/Topic/Note.md')
    return
  }
  const vault = treeToVault(tree)
  const counts = `${vault.subjects.length} subjects · ${vault.topics.length} topics · ${vault.notes.length} notes`
  let choice: 'replace' | 'merge' = mode ?? 'merge'
  if (!mode) {
    const answer = await modal({
      title: 'Import folder',
      subtitle: `Found ${counts}. Replace everything currently in the app, or merge into it?`,
      actions: [
        { label: 'Cancel', kind: 'ghost', value: '' },
        { label: 'Replace everything', kind: 'danger', value: 'replace' },
        { label: 'Merge', kind: 'primary', value: 'merge' },
      ],
    })
    if (!answer) return
    choice = answer.action === 'replace' ? 'replace' : 'merge'
  }
  if (choice === 'replace') {
    await replaceVault(vault)
    location.hash = routes.all
  } else await mergeVault(vault)
  refresh()
  toast(choice === 'replace' ? `Replaced with ${counts}` : `Merged ${counts}`)
}

/** One-click re-sync with the folder picked earlier. */
export async function refreshFromFolder() {
  const root = await loadFolderHandle()
  if (!root) {
    await exportToFolder()
    return
  }
  if (!(await ensurePermission(root))) {
    toast('Could not re-open the folder')
    return
  }
  const vault = await exportVault()
  await writeFilesToFolder(root, vaultToFiles(vault))
  toast('Folder updated — sync tool will carry it to your phone')
}

function readmeForVault(vault: Vault) {
  return [
    'Your notes, as plain Markdown.',
    '============================',
    '',
    'Structure: Subject / Topic / Note.md — this app reads and writes exactly that.',
    'These files are the archive; the app is just a view on them.',
    '',
    'Put this folder inside Syncthing, OneDrive or iCloud Drive and the same folder',
    'appears on your phone. In the app, use "Import from folder" to pull changes in',
    'and "Export to folder" to push edits out. notes.vault.json holds the exact',
    'data (ids, icons, ordering) in case a Markdown round-trip loses a nicety.',
    '',
    `Exported ${new Date().toLocaleString()} · ${vault.subjects.length} subjects, ${vault.notes.length} notes.`,
    '',
  ].join('\n')
}

