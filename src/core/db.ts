import Dexie, { type Table } from 'dexie'
import type { Block, Book, Digest, InkStroke, Note, Page, Revision, ScanRun, Settings, Subject, Topic, Vault } from './types'

/** Anything we need to remember that is not a note: e.g. the folder handle for syncing. */
interface MetaEntry {
  key: string
  handle?: unknown
  at?: number
}
import { uid } from './util'

/**
 * Storage lives behind this one file on purpose. Today it is IndexedDB in the
 * browser. If we ever want a synced backend, we replace the internals here and
 * nothing in the UI has to change.
 */
class NotesDB extends Dexie {
  subjects!: Table<Subject, string>
  topics!: Table<Topic, string>
  notes!: Table<Note, string>
  revisions!: Table<Revision, string>
  meta!: Table<MetaEntry, string>
  books!: Table<Book, string>
  pages!: Table<Page, string>
  digests!: Table<Digest, string>
  scanRuns!: Table<ScanRun, string>

  constructor() {
    super('notes')
    this.version(1).stores({
      subjects: 'id, name, updatedAt',
      topics: 'id, subjectId, order, updatedAt',
      notes: 'id, topicId, updatedAt',
      revisions: 'id, noteId, at',
    })
    this.version(2).stores({ meta: 'key' })
    this.version(3).stores({
      books: 'id, title, subjectId, updatedAt',
      pages: 'id, bookId, n, [bookId+n]',
    })
    this.version(4).stores({
      digests: 'id, bookId, page, [bookId+page], at',
      scanRuns: 'id, at, bookId',
    })
  }
}

export const db = new NotesDB()
export const settingsKey = 'notes.settings.v1'

/* ------------------------------------------------------------------ reads */

export const listSubjects = () => db.subjects.orderBy('name').toArray()
export const getSubject = (id: string) => db.subjects.get(id)
export const listTopics = (subjectId: string) =>
  db.topics.where('subjectId').equals(subjectId).toArray().then((ts) => ts.sort((a, b) => a.order - b.order))
export const listAllTopics = () => db.topics.toArray()
export const getTopic = (id: string) => db.topics.get(id)
export const listNotes = (topicId: string) => db.notes.where('topicId').equals(topicId).toArray()
export const getNote = (id: string) => db.notes.get(id)
export const listAllNotes = () => db.notes.toArray()
export const countNotes = (topicId: string) => db.notes.where('topicId').equals(topicId).count()

export async function topicSummary(subjectId: string) {
  const topics = await listTopics(subjectId)
  const notes = await Promise.all(topics.map((t) => countNotes(t.id)))
  return topics.map((t, i) => ({ topic: t, noteCount: notes[i]! }))
}

/* ----------------------------------------------------------------- writes */

export async function createSubject(name: string, emoji = '📚', color = 'graphite'): Promise<Subject> {
  const now = Date.now()
  const subject: Subject = { id: uid('s'), name: name.trim() || 'Untitled', emoji, color, createdAt: now, updatedAt: now }
  await db.subjects.put(subject)
  return subject
}

export async function createTopic(subjectId: string, name: string, emoji = '📄'): Promise<Topic> {
  const siblings = await listTopics(subjectId)
  const now = Date.now()
  const topic: Topic = {
    id: uid('t'),
    subjectId,
    name: name.trim() || 'Untitled topic',
    emoji,
    order: (siblings.at(-1)?.order ?? 0) + 1,
    createdAt: now,
    updatedAt: now,
  }
  await db.topics.put(topic)
  return topic
}

export async function createNote(
  topicId: string,
  title = 'Untitled',
  blocks?: Block[],
  icon = '📝',
): Promise<Note> {
  const now = Date.now()
  const note: Note = {
    id: uid('n'),
    topicId,
    title: title.trim() || 'Untitled',
    icon,
    blocks: blocks?.length ? blocks : [{ id: uid('b'), type: 'text', content: '' }],
    createdAt: now,
    updatedAt: now,
  }
  await db.notes.put(note)
  return note
}

export async function touchNote(noteId: string, patch: Partial<Note>) {
  await db.notes.update(noteId, { ...patch, updatedAt: Date.now() })
}

export async function saveBlocks(noteId: string, blocks: Block[]) {
  await db.notes.update(noteId, { blocks, updatedAt: Date.now() })
}

export async function updateSubject(id: string, patch: Partial<Subject>) {
  await db.subjects.update(id, { ...patch, updatedAt: Date.now() })
}
export async function updateTopic(id: string, patch: Partial<Topic>) {
  await db.topics.update(id, { ...patch, updatedAt: Date.now() })
}

export async function moveTopic(topicId: string, toSubjectId: string, order: number) {
  await db.topics.update(topicId, { subjectId: toSubjectId, order, updatedAt: Date.now() })
}

export async function moveNote(noteId: string, toTopicId: string) {
  const n = await db.notes.get(noteId)
  if (!n) return
  await db.notes.put({ ...n, topicId: toTopicId, updatedAt: Date.now() })
}

/** Deletes a subject together with everything below it. */
export async function deleteSubject(id: string) {
  const topics = await listTopics(id)
  await Promise.all(topics.map((t) => deleteTopic(t.id)))
  for (const b of await listBooks(id)) await deleteBook(b.id)
  await db.subjects.delete(id)
}

export async function deleteTopic(id: string) {
  const notes = await listNotes(id)
  await db.notes.bulkDelete(notes.map((n) => n.id))
  await db.revisions.where('noteId').anyOf(notes.map((n) => n.id)).delete()
  await db.topics.delete(id)
}

export async function deleteNote(id: string) {
  await db.notes.delete(id)
  await db.revisions.where('noteId').equals(id).delete()
}

/** Persist a new sidebar order for one subject's topics. */
export async function setTopicOrder(subjectId: string, orderedIds: string[]) {
  await Promise.all(orderedIds.map((id, i) => db.topics.update(id, { order: i, subjectId })))
}

/* ---------------------------------------------------------------- history */

const KEEP_REVISIONS = 25

export async function snapshot(note: Note) {
  const json = JSON.stringify({ title: note.title, blocks: note.blocks })
  const prev = await db.revisions.where('noteId').equals(note.id).last()
  if (prev && prev.json === json) return
  await db.revisions.put({ id: uid('r'), noteId: note.id, at: Date.now(), json })
  const all = await db.revisions.where('noteId').equals(note.id).toArray()
  if (all.length > KEEP_REVISIONS) await db.revisions.bulkDelete(all.slice(0, all.length - KEEP_REVISIONS).map((r) => r.id))
}

export const listRevisions = (noteId: string) =>
  db.revisions.where('noteId').equals(noteId).toArray().then((rs) => rs.reverse())

export async function restoreRevision(rev: Revision) {
  const parsed = JSON.parse(rev.json) as { title: string; blocks: Block[] }
  await db.notes.update(rev.noteId, { ...parsed, updatedAt: Date.now() })
}

/* ---------------------------------------------------------------- settings */

/** Settings live in localStorage: available before the DB opens, and no async dance needed. */
export async function getSettings(): Promise<Settings> {
  const raw = localStorage.getItem(settingsKey)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Settings
  } catch {
    return {}
  }
}

export async function setSettings(patch: Partial<Settings>) {
  const next = { ...(await getSettings()), ...patch }
  localStorage.setItem(settingsKey, JSON.stringify(next))
  return next
}

/* ------------------------------------------------------------------ search */

export interface Hit {
  note: Note
  topic: Topic
  subject: Subject
  snippet: string
}

const noteHaystack = (n: Note) =>
  `${n.title}\n${n.blocks.map((b) => `${b.label ?? ''} ${b.caption ?? ''} ${b.content ?? ''} ${b.note ?? ''}`).join('\n')}`
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')

export async function searchNotes(query: string, subjectId?: string): Promise<Hit[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/)
  const notes = await db.notes.toArray()
  const topics = await db.topics.toArray()
  const subjects = await db.subjects.toArray()
  const topicById = new Map(topics.map((t) => [t.id, t]))
  const subjectById = new Map(subjects.map((s) => [s.id, s]))
  const hits: Hit[] = []
  for (const note of notes) {
    const topic = topicById.get(note.topicId)
    if (!topic) continue
    const subject = subjectById.get(topic.subjectId)
    if (!subject) continue
    if (subjectId && subject.id !== subjectId) continue
    const hay = noteHaystack(note).toLowerCase()
    if (!terms.every((t) => hay.includes(t))) continue
    const at = hay.indexOf(terms[0]!)
    const start = Math.max(0, at - 45)
    const snippet = noteHaystack(note).slice(start, start + 150)
    hits.push({ note, topic, subject, snippet: (start > 0 ? '…' : '') + snippet })
  }
  return hits
    .sort((a, b) => b.note.updatedAt - a.note.updatedAt)
    .slice(0, 40)
}

/* ---------------------------------------------------------------- library */

export interface LibraryEntry {
  block: Block
  note: Note
  topic: Topic
  subject: Subject
}

export async function allLinks(): Promise<LibraryEntry[]> {
  const [notes, topics, subjects] = await Promise.all([listAllNotes(), listAllTopics(), listSubjects()])
  const topicById = new Map(topics.map((t) => [t.id, t]))
  const subjectById = new Map(subjects.map((s) => [s.id, s]))
  const out: LibraryEntry[] = []
  for (const note of notes) {
    const topic = topicById.get(note.topicId)
    if (!topic) continue
    const subject = subjectById.get(topic.subjectId)
    if (!subject) continue
    for (const block of note.blocks) if (block.type === 'link' && block.url) out.push({ block, note, topic, subject })
  }
  return out.sort((a, b) => (b.block.addedAt ?? 0) - (a.block.addedAt ?? 0))
}

export async function patchLink(noteId: string, blockId: string, patch: Partial<Block>) {
  const note = await db.notes.get(noteId)
  if (!note) return
  note.blocks = note.blocks.map((b) => (b.id === blockId ? { ...b, ...patch } : b))
  note.updatedAt = Date.now()
  await db.notes.put(note)
}

/* ------------------------------------------------------------- whole vault */

export async function exportVault(): Promise<Vault> {
  return {
    version: 1,
    exportedAt: Date.now(),
    subjects: await db.subjects.toArray(),
    topics: await db.topics.toArray(),
    notes: await db.notes.toArray(),
  }
}

export async function replaceVault(vault: Vault) {
  await db.transaction(
    'rw',
    [db.subjects, db.topics, db.notes, db.revisions, db.books, db.pages, db.digests],
    async (tx) => {
      const tables = {
        subjects: db.subjects,
        topics: db.topics,
        notes: db.notes,
        revisions: db.revisions,
        books: db.books,
        pages: db.pages,
        digests: db.digests,
      }
      // digests are regenerable, but a replaced vault means "start from these files"
      await Promise.all(
        [tables.subjects, tables.topics, tables.notes, tables.revisions, tables.books, tables.pages, tables.digests].map((t) => t.clear()),
      )
      void tx
      await tables.subjects.bulkPut(vault.subjects ?? [])
      await tables.topics.bulkPut(vault.topics ?? [])
      await tables.notes.bulkPut(vault.notes ?? [])
    },
  )
}

export async function mergeVault(vault: Vault) {
  const existingSubjects = await db.subjects.toArray()
  const existingTopics = await db.topics.toArray()
  const byName = new Map(existingSubjects.map((s) => [s.name.toLowerCase(), s]))
  const byTopicKey = new Map(existingTopics.map((t) => [`${t.subjectId}::${t.name.toLowerCase()}`, t]))

  const subjectRemap = new Map<string, string>()
  const topicRemap = new Map<string, string>()

  for (const s of vault.subjects ?? []) {
    const mine = byName.get(s.name.toLowerCase())
    if (mine) subjectRemap.set(s.id, mine.id)
    else {
      await db.subjects.put(s)
      byName.set(s.name.toLowerCase(), s)
      subjectRemap.set(s.id, s.id)
    }
  }
  for (const t of vault.topics ?? []) {
    const subjectId = subjectRemap.get(t.subjectId) ?? t.subjectId
    const mine = byTopicKey.get(`${subjectId}::${t.name.toLowerCase()}`)
    if (mine) topicRemap.set(t.id, mine.id)
    else {
      const copy = { ...t, subjectId }
      await db.topics.put(copy)
      byTopicKey.set(`${subjectId}::${copy.name.toLowerCase()}`, copy)
      topicRemap.set(t.id, copy.id)
    }
  }
  let added = 0
  for (const n of vault.notes ?? []) {
    const topicId = topicRemap.get(n.topicId) ?? n.topicId
    const siblings = await db.notes.where('topicId').equals(topicId).toArray()
    if (siblings.some((s) => s.title === n.title && s.updatedAt === n.updatedAt)) continue
    await db.notes.put({ ...n, topicId, id: uid('n') })
    added++
  }
  return added
}

/* ------------------------------------------------------------------ books */

export async function listBooks(subjectId?: string) {
  const all = await db.books.toArray()
  const books = subjectId ? all.filter((b) => b.subjectId === subjectId) : all
  return books.sort((a, b) => a.title.localeCompare(b.title))
}
export const getBook = (id: string) => db.books.get(id)
export async function putBook(book: Book) {
  await db.books.put({ ...book, updatedAt: Date.now() })
}
export async function getPage(bookId: string, n: number) {
  return db.pages.where('[bookId+n]').equals([bookId, n]).first()
}
export async function getPages(bookId: string, from: number, to: number) {
  const all = await db.pages.where('bookId').equals(bookId).toArray()
  return all.filter((p) => p.n >= from && p.n <= to).sort((a, b) => a.n - b.n)
}
export const pageCount = (bookId: string) => db.pages.where('bookId').equals(bookId).count()
export async function putPages(pages: Page[]) {
  await db.pages.bulkPut(pages)
}
export async function setPageInk(bookId: string, n: number, ink: InkStroke[]) {
  const page = await getPage(bookId, n)
  if (page) await db.pages.update(page.id, { ink })
}
export async function pageTexts(bookId: string) {
  const pages = await db.pages.where('bookId').equals(bookId).toArray()
  return pages.sort((a, b) => a.n - b.n).map((p) => ({ n: p.n, text: p.text ?? '', ocr: p.ocr ?? 'none' }))
}
export async function deleteBook(id: string) {
  await db.pages.where('bookId').equals(id).delete()
  await db.digests.where('bookId').equals(id).delete()
  await db.books.delete(id)
}
/** Rough size of a book's images, for the "this will cost you MB" warning. */
export async function bookBytes(bookId: string) {
  const pages = await db.pages.where('bookId').equals(bookId).toArray()
  return pages.reduce((sum, p) => sum + (p.image ? Math.round(p.image.length * 0.75) : 0), 0)
}

/* --------------------------------------------------------- digests & scans */

export const digestFor = (bookId: string, page: number) => db.digests.where('[bookId+page]').equals([bookId, page]).first()
export const listDigests = (bookId: string) =>
  db.digests.where('bookId').equals(bookId).toArray().then((ds) => ds.sort((a, b) => a.page - b.page))
export async function putDigest(digest: Digest) {
  await db.digests.put(digest)
}
export const digestCount = (bookId: string) => db.digests.where('bookId').equals(bookId).count()
export async function putScanRun(run: ScanRun) {
  await db.scanRuns.put(run)
}
export const listScanRuns = (limit = 20) => db.scanRuns.orderBy('at').reverse().limit(limit).toArray()
export const deleteScanRun = (id: string) => db.scanRuns.delete(id)

/* ------------------------------------------------------------------- seeds */

// content means different things per type: HTML for text blocks, raw text for code
const b = (type: Block['type'], content: string, extra: Partial<Block> = {}): Block =>
  type === 'code'
    ? { id: uid('b'), type, content, ...extra }
    : { id: uid('b'), type, content: content || '', ...extra }

export async function seedIfEmpty(): Promise<boolean> {
  const settings = await getSettings()
  if (settings.seeded) return false
  if (await db.subjects.count()) {
    await setSettings({ seeded: true })
    return false
  }

  const linear = await createSubject('Linear Algebra', '📐', 'indigo')
  const t1 = await createTopic(linear.id, 'Foundations', '🧱')
  const t2 = await createTopic(linear.id, 'Eigen-everything', '🎯')
  await createNote(
    t1.id,
    'Start here — how to use Notes',
    [
      b('callout', 'This is a <b>block editor</b>. Press <b>Enter</b> for a new block, type <b>/</b> on an empty block to turn it into anything else, hover a block and grab the ⠿ handle to move it.'),
      b('h2', 'What is where'),
      b('bulleted', '<b>Top tabs</b> — one per subject. Click <i>All</i> for the overview.'),
      b('bulleted', '<b>Left sidebar</b> — topics of the open subject, and their notes nested under them.'),
      b('bulleted', '<b>⌘K / Ctrl-K</b> — search everything, or run a command.'),
      b('bulleted', '<b>Bottom left</b> — Export / Import, so the folder of Markdown files stays your real archive.'),
      b('todo', 'Make your first subject', { checked: false }),
      b('todo', 'Set up a synced folder (Syncthing or OneDrive)', { checked: false }),
      b('quote', 'A quiet tool is a fast tool.'),
      b('text', 'Links you paste below become cards with a type, a favicon and a spot for your own note about them.'),
      b('link', '', {
        url: 'https://www.youtube.com/watch?v=fNk_zzaMoSs',
        label: 'Essence of Linear Algebra (3Blue1Brown)',
        kind: 'video',
        embed: true,
        addedAt: Date.now(),
        note: 'Watch chapters 1–3 before the eigenvalue notes.',
      }),
      b('link', '', {
        url: 'https://web.mit.edu/18.06/www/',
        label: 'MIT 18.06 course page',
        kind: 'article',
        embed: true,
        addedAt: Date.now(),
      }),
      b('divider', ''),
      b('h3', 'Where the files go'),
      b('text', 'Use <b>Export to folder…</b> and pick a folder inside your synced drive. The app writes plain <code>.md</code> files, so your notes are readable without this app — that is the point.'),
      b('code', 'notes/\n  Organic Chemistry/\n    Enzymes/\n      Kinetics.md   <- one note\n  Design/\n        ...'),
    ],
    '👋',
  )
  await createNote(t1.id, 'Vectors, honestly', [
    b('text', 'A vector is just a list you can add and scale. Everything else is decoration.'),
    b('bulleted', 'Rⁿ: n numbers, added component-wise'),
    b('bulleted', 'The span of a set = all linear combinations'),
    b('code', 'v = [1, 2]\nw = 3 * v        # [3, 6]\nnormalize = v / norm(v)'),
  ])
  await createNote(t2.id, 'Eigenvectors in one page', [
    b('text', 'Av = λv: the direction survives the transformation, only its length changes.'),
    b('toggle', 'How to actually find them', { collapsed: false }),
    b('text', 'det(A − λI) = 0 gives λ, then solve (A − λI)x = 0.', { indent: 1 }),
    b('link', '', {
      url: 'https://en.wikipedia.org/wiki/Eigenvalue_algorithm',
      label: 'Eigenvalue algorithm',
      kind: 'article',
      embed: false,
      addedAt: Date.now(),
      read: true,
    }),
  ])

  const design = await createSubject('Design', '✏️', 'rose')
  const dt = await createTopic(design.id, 'Type & layout', '🔤')
  await createNote(dt.id, 'Why macOS feels tidy', [
    b('bulleted', 'Hairline separators instead of boxes'),
    b('bulleted', 'One accent colour, everything else gray'),
    b('bulleted', 'Translucency only where there is real depth'),
    b('bulleted', '8pt rhythm, generous side margins'),
    b('text', 'This app borrows all four. Toggle the theme with the sun/moon button in the sidebar.'),
  ])
  await createTopic(design.id, 'Notes on notes', '🗒️')

  /* A sample "book" so the reader, the pen and the search have something to show
     on first run — the shape of a real import, without shipping copyrighted text. */
  const pagesText = [
    'La derivata misura quanto cambia una funzione al variare della sua variabile. Sia f(x) = x^2: il rapporto incrementale (f(x+h) - f(x))/h tende a 2x quando h tende a zero.',
    'Regole di derivazione: la derivata di una somma e la somma delle derivate; la derivata di un prodotto f·g vale f\'g + fg\'; il quoziente segue la regola (f\'g - fg\')/g^2.',
    'Le funzioni notevoli: seno e coseno si derivano l\'uno nell\'altro, l\'esponenziale resta se stesso. Il grafico della derivata seconda dice dove la curva e concava.',
    'Esercizi: calcola la derivata di x^3 ln x, studia il segno della derivata prima, trova i punti di flesso della curva data.',
  ]
  const sampleBook: Book = {
    id: uid('k'),
    title: 'Manuale di esempio — Derivate',
    author: 'notes · pagina dimostrativa',
    subjectId: linear.id,
    pageCount: pagesText.length,
    origin: 'manual',
    textCoverage: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await db.books.put(sampleBook)
  await db.pages.bulkPut(
    pagesText.map((text, i) => ({
      id: uid('p'),
      bookId: sampleBook.id,
      n: i + 1,
      text,
      ocr: 'text' as const,
      ...(i === 0
        ? {
            ink: [
              {
                t: 'highlight' as const,
                c: '#ffd43b',
                w: 2.2,
                d: [40, 232, 250, 232, 470, 232, 690, 232, 900, 232],
              },
            ],
          }
        : {}),
    })),
  )

  /* One page the local model has already "studied": the reader shows the strip filled. */
  await db.digests.put({
    id: `d_${sampleBook.id}_2`,
    bookId: sampleBook.id,
    page: 2,
    at: Date.now(),
    md: [
      '**Idee** (p. 2)',
      '- La derivata è un operatore lineare: deriva di una somma = somma delle derivate',
      '- Prodotto e quoziente hanno regole proprie, non banali',
      '',
      '**Definizioni** (p. 2)',
      '- (f·g)\'= f\'g + fg\': il prodotto non si deriva "a pezzi"',
      '- (f/g)\'= (f\'g - fg\')/g², con g diverso da zero',
      '',
      '**Domande** (p. 2)',
      '- Perché la derivata di un prodotto ha due termini?',
      '- Che condizione serve per applicare la regola del quoziente?',
    ].join('\n'),
    keyIdeas: ['La derivata è un operatore lineare: deriva di una somma = somma delle derivate', 'Prodotto e quoziente hanno regole proprie, non banali'],
    definitions: ['(f·g)\'= f\'g + fg\' — il prodotto non si deriva a pezzi', "(f/g)'= (f'g - fg')/g\u00b2, con g diverso da zero"],
    examQuestions: ['Perché la derivata di un prodotto ha due termini?', 'Che condizione serve per applicare la regola del quoziente?'],
    links: ['La pagina 1 introduce il rapporto incrementale: senza quello, le regole sembrano formule magiche'],
    chars: 260,
  })

  await setSettings({ seeded: true })
  return true
}
