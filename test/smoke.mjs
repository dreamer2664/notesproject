/**
 * Boots the actual app bundle inside jsdom with a real IndexedDB shim, then checks
 * that the seeded vault renders: subject tabs, the sidebar tree, and — once we
 * navigate to a note — a live block editor. This exercises main.ts, views.ts,
 * db.ts and editor.ts for real; nothing here re-implements them.
 *
 * Run: npm run smoke
 */
import { JSDOM } from 'jsdom'
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
  url: 'https://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom

const raf = (fn) => setTimeout(() => fn(Date.now()), 0)
Object.assign(window, {
  requestAnimationFrame: raf,
  cancelAnimationFrame: clearTimeout,
  matchMedia:
    window.matchMedia ??
    ((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    })),
})
window.Element.prototype.animate = function () {
  return { finished: Promise.resolve(), cancel() {}, onfinish: null }
}
// jsdom implements neither innerText nor <br>-aware serialization; the editor reads innerText.
if (!('innerText' in window.HTMLElement.prototype)) {
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() {
      return (this.textContent ?? '')
        .replace(/\u00a0/g, ' ')
        .replace(/<br>/gi, '\n')
    },
    set(v) {
      this.textContent = v
    },
    configurable: true,
  })
}
window.HTMLElement.prototype.scrollIntoView = function () {}
window.Element.prototype.scrollIntoView = function () {}
if (!window.crypto?.randomUUID) {
  Object.defineProperty(window, 'crypto', { value: { ...(window.crypto || {}), randomUUID: () => Math.random().toString(16).slice(2) } })
}
// localStorage exists in jsdom; clipboard and file pickers do not, so stub the calls the app guards.
Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {}, readText: async () => '' }, configurable: true })

for (const key of [ 'document', 'Element', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'DOMParser', 'XMLSerializer', 'navigator', 'localStorage', 'location', 'getComputedStyle', 'requestAnimationFrame', 'Image', 'Blob', 'File', 'FileReader', 'performance', 'history', 'HTMLCollection']) {
  Object.defineProperty(globalThis, key, { value: window[key] ?? globalThis[key], configurable: true, writable: true })
}
Object.defineProperty(globalThis, 'window', { value: window, configurable: true, writable: true })

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

// jsdom validates the `signal` option against its own realm's AbortSignal, but the bundle
// uses the global AbortController. Wrap addEventListener so a foreign signal still works
// (and still detaches), instead of throwing inside the app.
function tolerateForeignSignals(target, label) {
  const orig = target.addEventListener.bind(target)
  target.addEventListener = (type, listener, options) => {
    if (options && typeof options === 'object' && 'signal' in options && typeof options.signal?.addEventListener === 'function') {
      const { signal, ...rest } = options
      try {
        orig(type, listener, rest)
      } catch (err) {
        console.error(`  harness: addEventListener(${type} on ${label}) failed:`, err.message)
        return
      }
      signal.addEventListener('abort', () => {
        try {
          target.removeEventListener(type, listener)
        } catch {
          /* already gone */
        }
      })
      return
    }
    orig(type, listener, options)
  }
}
tolerateForeignSignals(window.document, 'document')
tolerateForeignSignals(window, 'window')
void (globalThis.AbortController = window.AbortController ?? globalThis.AbortController)

const run = async () => {
  await import('./.tmp/app.cjs')

  await tick(400)
  const doc = window.document

  const text = (sel) => Array.from(doc.querySelectorAll(sel)).map((n) => (n.textContent ?? '').trim())

  assert.ok(doc.querySelector('.layout'), 'shell did not mount')
  assert.ok(doc.querySelectorAll('.tab').length >= 2, `expected subject tabs, got ${doc.querySelectorAll('.tab').length}`)
  assert.ok(
    text('.card h2').some((t) => t.includes('Linear Algebra')),
    `seeded subject missing from dashboard: ${JSON.stringify(text('.card h2'))}`,
  )
  assert.ok(doc.querySelectorAll('.note-cards, .recent-row').length, 'no note cards on the overview')

  // deep-link into a note and check the editor really renders blocks
  // The seeded "how to use" note exercises the widest set of block types.
  const href = Array.from(doc.querySelectorAll('.recent-row'))
    .map((a) => a.getAttribute('href'))
    .find(Boolean)
  assert.ok(href, 'no recent-note link to follow')
  const openNote = async (hash, patchable = false) => {
    // a page change inside a book is a *patch*, not a navigation: no hashchange event
    if (!patchable) window.location.hash = hash
    else window.location.hash = hash
    if (!patchable) window.dispatchEvent(new window.Event('hashchange'))
    await tick(400)
  }
  await openNote(href)
  const startHref = Array.from(doc.querySelectorAll('a'))
    .map((a) => a.getAttribute('href'))
    .find((h2) => h2 && /how-to-use|Start here/.test(h2))
  void startHref

  assert.ok(doc.querySelector('.note'), 'note view did not render')
  assert.ok(doc.querySelector('.note-title'), 'note title missing')
  let rows = doc.querySelectorAll('.brow')
  assert.ok(rows.length >= 3, `expected seeded blocks in the editor, got ${rows.length}`)
  const seen = new Set()
  for (const b of rows) seen.add(b.getAttribute('data-type'))

  // open the guide note through the dashboard / topic cards so we hit every block type.
  // (We navigate by clicking rather than by poking the DB: the bundle owns its own module
  // instance, so reaching in from here would create a second one.)
  const hashOf = (re) => {
    for (const a of doc.querySelectorAll('a[href^="#/"]')) {
      const t = (a.textContent ?? '').replace(/\s+/g, ' ').trim()
      const h2 = a.getAttribute('href')
      if (h2 && re.test(t)) return h2
    }
    return null
  }
  let guideHash = hashOf(/Start here/)
  const seenLinks = () => Array.from(doc.querySelectorAll('a')).map((a) => (a.textContent ?? '').replace(/\s+/g, ' ').trim()).slice(0, 14).join(' | ')
  if (!guideHash) {
    const subject = hashOf(/Linear Algebra/)
    assert.ok(subject, `no subject tab to click: ${seenLinks()}`)
    await openNote(subject)
    await tick(400)
    guideHash = hashOf(/Start here/)
  }
  if (!guideHash) {
    const topic = hashOf(/Foundations/)
    assert.ok(topic, `no topic card to click: ${seenLinks()}`)
    await openNote(topic)
    await tick(400)
    guideHash = hashOf(/Start here/)
  }
  assert.ok(guideHash, 'the guide note is unreachable from the dashboard and topic view')
  await openNote(guideHash)
  await tick(250)
  const sidebarTitles = Array.from(doc.querySelectorAll('.note-link')).map((a) => (a.textContent ?? '').trim())
  assert.ok(sidebarTitles.some((t2) => /Start here/.test(t2)), `sidebar is missing nested notes: ${JSON.stringify(sidebarTitles)}`)
  rows = doc.querySelectorAll('.brow')
  for (const b of rows) seen.add(b.getAttribute('data-type'))
  assert.ok(rows.length >= 10, `guide note should render its blocks, got ${rows.length}`)
  assert.ok(
    doc.querySelectorAll('.brow [contenteditable="true"]').length >= 8,
    `blocks are not editable: ${doc.querySelectorAll('.brow [contenteditable="true"]').length} editable of ${rows.length}`,
  )
  assert.ok(doc.querySelector('.brow[data-type="h2"] .b-text'), 'headings are not editable text')
  assert.ok(doc.querySelectorAll('.brow .g-btn').length >= rows.length * 2, 'block gutters (+ / drag handle) missing')
  assert.ok(doc.querySelector('.brow[data-type="todo"] .b-check'), 'to-do block did not render a checkbox')
  assert.ok(doc.querySelector('.brow[data-type="link"] .b-link'), 'link card did not render')
  assert.ok(doc.querySelector('.brow[data-type="link"] .play-btn'), 'video link did not offer an embed player')
  assert.ok(doc.querySelectorAll('.refs-list .ref').length >= 2, 'references panel did not list the saved links')

  // a second note holds the code block, so visit it too
  const vectorsHash = hashOf(/Vectors, honestly/)
  assert.ok(vectorsHash, 'the second seeded note is unreachable')
  await openNote(vectorsHash)
  await tick(300)
  for (const b of doc.querySelectorAll('.brow')) seen.add(b.getAttribute('data-type'))
  assert.ok(doc.querySelector('.brow[data-type="code"] pre')?.textContent?.includes('normalize'), 'code block content did not render')

  for (const type of ['callout', 'h2', 'bulleted', 'todo', 'quote', 'link', 'divider', 'code', 'text']) {
    assert.ok(seen.has(type), `block type never rendered: ${type} (saw ${[...seen].join(', ')})`)
  }
  assert.ok(doc.querySelector('.refs'), 'references panel missing')

  // sidebar tree should show the topic of the open subject
  await tick(120)
  assert.ok(
    text('.trow-name').length >= 1,
    `sidebar topics missing: ${JSON.stringify(text('.trow'))}`,
  )

  // End-to-end: the note we are looking at must export as real Markdown through the app's
  // own menu, which proves seed -> save -> render -> collect -> md all agree.
  let clip = ''
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: async (t) => { clip = t }, readText: async () => '' },
    configurable: true,
  })
  await openNote(guideHash)
  await tick(300)
  const menuBtn = doc.querySelector('.note-head .note-meta .mini:last-child')
  assert.ok(menuBtn, 'note options button missing')
  menuBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick(60)
  const copyItem = Array.from(doc.querySelectorAll('.ctx-item')).find((n) => /Copy as Markdown/.test(n.textContent ?? ''))
  assert.ok(copyItem, `note menu missing (items: ${Array.from(doc.querySelectorAll('.ctx-item')).map((n) => n.textContent).join(', ')})`)
  copyItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick(300)
  // "Copy as Markdown" keeps the title, so a pasted note makes sense on its own...
  assert.match(clip, /^# Start here — how to use Notes\n\n/, 'copied markdown lost its title')
  // ...and the exported file must not repeat it (the filename *is* the title)
  const m = guideHash.match(/^#\/s\/(.+?)\/t\/(.+?)\/n\/(.+)$/)
  assert.ok(m, `unexpected note route: ${guideHash}`)
  const { noteToMd, vaultToFiles } = window.__notesTest
  const guideNote = { id: m[3], topicId: m[2], title: 'Start here — how to use Notes', icon: '👋', createdAt: 1, updatedAt: 1, blocks: [] }
  assert.doesNotMatch(noteToMd(guideNote).trimStart(), /^# Start here/, 'file body repeats the title')
  const files = vaultToFiles({
    version: 1,
    exportedAt: 1,
    subjects: [{ id: m[1], name: 'Linear Algebra', emoji: '📐', color: 'indigo', createdAt: 1, updatedAt: 1 }],
    topics: [{ id: m[2], subjectId: m[1], name: 'Foundations', emoji: '🧱', order: 1, createdAt: 1, updatedAt: 1 }],
    notes: [guideNote],
  })
  assert.ok(
    files.some((f) => f.path === 'Linear Algebra/Foundations/Start here — how to use Notes.md'),
    `folder layout wrong: ${files.map((f) => f.path).join(', ')}`,
  )
  assert.match(clip, /^> 💡 /m, 'callout missing from exported markdown')
  assert.match(clip, /^- \[ \] Make your first subject$/m, 'to-do missing from exported markdown')
  assert.match(clip, /^- \*\*\[Essence of Linear Algebra \(3Blue1Brown\)\]\(https:\/\/www\.youtube\.com\/watch\?v=fNk_zzaMoSs\)\*\*/m, 'link card missing from exported markdown')
  assert.match(clip, /^```/m, 'code block missing from exported markdown')

  const vault = await window.__notesTest.exportVault()
  assert.ok(vault.subjects.length >= 2, `subjects did not persist: ${vault.subjects.length}`)
  assert.ok(vault.notes.length >= 3, `notes did not persist: ${vault.notes.length}`)
  assert.ok(
    vault.notes.some((n) => n.blocks.some((b) => b.type === 'link' && b.url.startsWith('https://'))),
    'link blocks did not survive the save path',
  )
  assert.ok(
    vault.notes.some((n) => n.blocks.some((b) => b.type === 'code' && (b.content ?? '').includes('normalize'))),
    'code block content was lost while saving',
  )

  const linkNotes = vault.notes.filter((n) => n.blocks.some((b) => b.type === 'link')).length

  /* ------------------------------------------------ books, reader, pen, AI */
  const booksLink = Array.from(doc.querySelectorAll('a')).find((a) => (a.getAttribute('href') ?? '') === '#/books')
  assert.ok(booksLink, 'sidebar has no "Testi" entry')
  await openNote('#/books')
  await tick(350)
  const cards = doc.querySelectorAll('.book-card')
  assert.ok(cards.length >= 1, `no book cards on the books view: ${doc.querySelectorAll('.book-card').length}`)
  assert.ok(doc.querySelector('.book-card .cover-origin')?.textContent?.trim(), 'book card lost its origin badge')
  const sampleHref = doc.querySelector('.book-open')?.getAttribute('href') ?? ''
  assert.match(sampleHref, /^#\/b\//, 'book card does not link to the reader')

  await openNote(sampleHref)
  await tick(400)
  assert.ok(doc.querySelector('.reader .page-view'), 'reader did not render the page pane')
  assert.ok(doc.querySelector('.reader .rtitle b')?.textContent?.includes('Derivate'), 'reader header lost the book title')
  assert.ok(doc.querySelector('.reader .side-tabs'), 'reader side pane missing')
  assert.ok(doc.querySelectorAll('.reader .ink-svg path').length >= 1, 'the seeded page annotation did not render as ink')
  assert.ok(doc.querySelector('.reader .page-text-edit'), 'text tab did not show the page text')

  // turning a page must not rebuild the whole reader: the same <svg> node stays alive
  const svgBefore = doc.querySelector('.reader .ink-svg')
  const nextBtn = doc.querySelector('.rnav .rbtn[title*="successiva"]')
  assert.ok(nextBtn, 'reader has no next-page button')
  nextBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick(300)
  assert.equal(doc.querySelector('.page-jump')?.value, '2', 'next-page button did not move the page')
  assert.equal(doc.querySelector('.reader .ink-svg'), svgBefore, 'page turn rebuilt the reader instead of patching it')

  // the pen: turning it on makes the surface accept pointer events
  const drawBtn = doc.querySelector('.rbtn.draw')
  drawBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick(120)
  assert.ok(doc.querySelector('.page-view.ink-on'), 'pen toggle did not arm the ink surface')
  drawBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick(120)
  assert.ok(!doc.querySelector('.page-view.ink-on'), 'pen toggle did not disarm the ink surface')

  // search inside the book (BM25 over the real pages)
  const cercaTab = Array.from(doc.querySelectorAll('.side-tab')).find((t) => (t.textContent ?? '').trim() === 'Cerca')
  assert.ok(cercaTab, 'reader side pane has no search tab')
  cercaTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick(200)
  const search = doc.querySelector('.side-search')
  assert.ok(search, 'search tab did not render its input')
  search.value = 'quoziente'
  search.dispatchEvent(new window.Event('input', { bubbles: true }))
  await tick(600)
  const hits = Array.from(doc.querySelectorAll('.hit')).map((n) => (n.textContent ?? ''))
  assert.ok(hits.length >= 1, `no hits for a word that is in the book: ${JSON.stringify(hits)}`)
  assert.ok(hits.some((h) => h.includes('2')), 'the hit should point at page 2, where the quotient rule lives')
  doc.querySelectorAll('.hit')[0]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick(300)
  assert.equal(doc.querySelector('.page-jump')?.value, '2', 'clicking a search hit did not jump the page')

  // the AI tab has to survive Ollama being absent (jsdom: no server at all)
  const tabs = Array.from(doc.querySelectorAll('.side-tab'))
  const aiTab = tabs.find((t) => (t.textContent ?? '').trim() === 'AI')
  aiTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick(600)
  assert.ok(doc.querySelector('.ai-state'), 'AI panel did not render its status line')
  const askBtn = Array.from(doc.querySelectorAll('.ai-body .btn')).find((b) => /Chiedi/.test(b.textContent ?? ''))
  const aiText = doc.querySelector('.ai-ask')
  aiText.value = 'cos\' e la derivata?'
  askBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await tick(900)
  const msg = doc.querySelector('.ai-msg.ai')
  assert.ok(msg, 'asking without a local model produced no answer at all')
  assert.ok((msg.textContent ?? '').length > 20, 'the no-model fallback should still quote the book')
  assert.ok(doc.querySelector('.ai-msg.ai a.cite, .ai-msg.ai .ai-mode'), 'fallback answer lost its citations/mode note')

  // handwriting straight from the editor, through a page block
  await openImportProbe()
  async function openImportProbe() {
    const { openImport } = window.__notesTest
    await openImport([])
    await tick(200)
    assert.ok(doc.querySelector('.import-modal .drop'), 'import dialog did not mount its drop zone')
    doc.querySelector('.scrim')?.remove()
  }

  console.log(
    `  ok   smoke: shell + tabs + sidebar + dashboard + editor render ` +
      `(${vault.subjects.length} subjects, ${vault.notes.length} notes, ${rows.length} blocks in the last note, ` +
      `${linkNotes} note(s) with links, ${doc.querySelectorAll('.brow [contenteditable="true"]').length} editable blocks)`,
  )
  process.exit(0)
}

run().catch((err) => {
  console.error('  FAIL smoke:', err)
  process.exit(1)
})
