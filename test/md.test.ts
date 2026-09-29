/**
 * Run: npm test
 * Bundles this file with esbuild (already a Vite dependency) and runs it in node,
 * so the real md.ts / fs.ts code paths are exercised — no re-implemented logic.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blockToMd, mdToBlocks, noteToMd, treeToVault, vaultToFiles, inlineToMd } from '../src/core/md'
import { filesToTree, linkInfo } from '../src/core/fs'
import { chunkPage, Bm25, buildIndex, tokenize, stem, citePage } from '../src/core/search'
import { pdfItemsToText, cleanOcr } from '../src/core/import'
import { inkToSvg, svgToInk } from '../src/core/md'
import { PALETTE, packPoints, unpackPoints, eraseAt, strokePaths } from '../src/core/ink'
import type { InkStroke } from '../src/core/types'
import { EFFORT, extractQueries, sanitiseQuery, shouldEnrich, splitTranscript, ytSearchUrl, chat } from '../src/core/screenshot'
import { parseDigest, digestToMd } from '../src/core/study'
import { blockify } from '../src/ui/scan'
import type { Block, Note } from '../src/core/types'

function readSource(rel: string): string {
  // the bundle may live under node_modules/.tmp, so walk up until the repo root is found
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    try {
      return readFileSync(join(dir, rel), 'utf8')
    } catch {
      dir = join(dir, '..')
    }
  }
  throw new Error(`cannot find ${rel} from ${process.cwd()}`)
}

let n = 0
const block = (type: Block['type'], extra: Partial<Block> = {}): Block => ({ id: `b${++n}`, type, ...extra })
const note = (blocks: Block[]): Note => ({ id: 'n1', topicId: 't1', title: 'Test note', icon: '📝', blocks, createdAt: 1, updatedAt: 1 })

const tests: [string, () => void | Promise<void>][] = []
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn])

/* ---------------------------------------------------------------- inline */
test('inline: bold/italic/code/link survive the trip to markdown', () => {
  const html = 'Look at <b>this</b> and <i>that</i>, plus <code>x = 1</code> and <a href="https://example.com/a">the doc</a>.'
  assert.equal(inlineToMd(html), 'Look at **this** and *that*, plus `x = 1` and [the doc](https://example.com/a).')
})
test('inline: nested tags do not lose text', () => {
  assert.equal(inlineToMd('<b>bold <i>and italic</i></b>'), '**bold *and italic***')
})
test('inline: entities are decoded', () => {
  assert.equal(inlineToMd('a &amp; b &lt; c'), 'a & b < c')
})

/* ---------------------------------------------------------------- blocks */
test('blockToMd: every texty type gets its marker', () => {
  assert.match(blockToMd(block('h1', { content: 'Title' })), /^# Title$/)
  assert.match(blockToMd(block('h2', { content: 'Sub' })), /^## Sub$/)
  assert.match(blockToMd(block('bulleted', { content: 'one' })), /^- one$/)
  assert.match(blockToMd(block('numbered', { content: 'one' })), /^1\. one$/)
  assert.match(blockToMd(block('todo', { content: 'one', checked: true })), /^- \[x\] one$/)
  assert.match(blockToMd(block('quote', { content: 'sugar' })), /^> sugar$/)
  assert.match(blockToMd(block('callout', { content: 'careful' })), /^> 💡 careful$/)
  assert.match(blockToMd(block('divider', {})), /^---$/)
})
test('blockToMd: indent becomes two spaces per level', () => {
  assert.match(blockToMd(block('bulleted', { content: 'child', indent: 2 })), /^ {4}- child$/)
  // and the reader agrees: 4 leading spaces -> level 2
  assert.equal(mdToBlocks('- a\n    - deep')[1]!.indent, 2)
})
test('blockToMd: code fences keep newlines', () => {
  const md = noteToMd(note([block('code', { content: 'a = 1\nb = 2' })]))
  assert.equal(md, '```\na = 1\nb = 2\n```\n')
})
test('blockToMd: link blocks carry kind, state and note', () => {
  const md = blockToMd(
    block('link', { url: 'https://youtu.be/abc', label: 'Lecture 1', kind: 'video', read: true, starred: true, note: 'watch 4:10' }),
  )
  assert.match(md, /\*\*\[Lecture 1\]\(https:\/\/youtu\.be\/abc\)\*\*/)
  assert.match(md, /kind: video/)
  assert.match(md, /read/)
  assert.match(md, /⭐/)
  assert.match(md, /note: watch 4:10/)
})

/* ---------------------------------------------------------------- parser */
test('mdToBlocks: reads back the markers we write', () => {
  const md = ['# Title', '## Part', '- one', '1. first', '- [x] done', '- [ ] todo', '> quoted', '---', 'plain text'].join('\n')
  const kinds = mdToBlocks(md).map((b) => b.type)
  assert.deepEqual(kinds, ['h1', 'h2', 'bulleted', 'numbered', 'todo', 'todo', 'quote', 'divider', 'text'])
  const todos = mdToBlocks(md).filter((b) => b.type === 'todo')
  assert.equal(todos[0]!.checked, true)
  assert.equal(todos[1]!.checked, false)
})
test('mdToBlocks: nested bullets keep their indent level', () => {
  const blocks = mdToBlocks('- parent\n  - child\n    - grandchild')
  assert.deepEqual(blocks.map((b) => b.indent ?? 0), [0, 1, 2])
})
test('mdToBlocks: fenced code keeps newlines and closes even if unterminated', () => {
  const blocks = mdToBlocks('```js\nconst a = 1\nconst b = 2\n```')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]!.content, 'const a = 1\nconst b = 2')
  const open = mdToBlocks('```\nx = 1')
  assert.equal(open.at(-1)!.type, 'code')
})
test('mdToBlocks: a saved link line becomes a link card', () => {
  const md = '- **[Lecture 1](<https://youtu.be/abc>)** · kind: video · unread · note: watch 4:10'
  const [b] = mdToBlocks(md)
  assert.equal(b!.type, 'link')
  assert.equal(b!.url, 'https://youtu.be/abc')
  assert.equal(b!.label, 'Lecture 1')
  assert.equal(b!.kind, 'video')
  assert.equal(b!.note, 'watch 4:10')
  assert.equal(b!.read, false)
})
test('mdToBlocks: callout round-trips', () => {
  const [b] = mdToBlocks(blockToMd(block('callout', { content: 'careful **here**' })))
  assert.equal(b!.type, 'callout')
  assert.match(b!.content ?? '', /<b>here<\/b>/)
})
test('mdToBlocks: empty input still yields one editable block', () => {
  assert.equal(mdToBlocks('').length, 1)
  assert.equal(mdToBlocks('')[0]!.type, 'text')
})

/* ------------------------------------------------------------- round-trip */
test('round-trip: note -> md -> blocks preserves structure', () => {
  const original = [
    block('h2', { content: 'Week 3' }),
    block('text', { content: 'Some <b>bold</b> prose' }),
    block('bulleted', { content: 'alpha' }),
    block('bulleted', { content: 'beta', indent: 1 }),
    block('todo', { content: 'buy milk', checked: true }),
    block('code', { content: 'f(x) = x^2' }),
    block('quote', { content: 'a saying' }),
    block('link', { url: 'https://en.wikipedia.org/wiki/Vector', label: 'Vector', kind: 'article', addedAt: 1 }),
    block('divider', {}),
  ]
  const md = noteToMd(note(original))
  const back = mdToBlocks(md)
  assert.deepEqual(back.map((b) => b.type), original.map((b) => b.type))
  assert.equal(back.find((b) => b.type === 'link')!.url, 'https://en.wikipedia.org/wiki/Vector')
  assert.equal(back.find((b) => b.type === 'todo')!.checked, true)
  assert.equal(back.find((b) => b.type === 'bulleted' && b.indent === 1)!.content.replace(/<[^>]+>/g, ''), 'beta')
})

/* ---------------------------------------------------------------- folder */
test('vaultToFiles: Subject/Topic/Note.md plus a json manifest', () => {
  const vault = {
    version: 1 as const,
    exportedAt: 1,
    subjects: [{ id: 's1', name: 'Organic Chemistry', emoji: '🧪', color: 'teal', createdAt: 1, updatedAt: 1 }],
    topics: [{ id: 't1', subjectId: 's1', name: 'Enzymes', emoji: '🧩', order: 1, createdAt: 1, updatedAt: 1 }],
    notes: [
      { ...note([block('text', { content: 'body' })]), id: 'n1', topicId: 't1', title: 'Kinetics' },
      { ...note([block('text', { content: 'other' })]), id: 'n2', topicId: 't1', title: 'Inhibitors' },
    ],
  }
  const files = vaultToFiles(vault)
  const paths = files.map((f) => f.path)
  assert.ok(paths.includes('Organic Chemistry/Enzymes/Kinetics.md'), paths.join(', '))
  assert.ok(paths.includes('Organic Chemistry/Enzymes/Inhibitors.md'))
  assert.ok(paths.includes('notes.vault.json'))
  assert.ok(paths.includes('Organic Chemistry.folder.md'))
  const body = files.find((f) => f.path.endsWith('Kinetics.md'))!.text
  assert.match(body, /^body\n?$/)
  assert.ok(body.endsWith('\n'), 'every md file ends with a newline')
})
test('vaultToFiles: duplicate titles do not overwrite each other', () => {
  const vault = {
    version: 1 as const,
    exportedAt: 1,
    subjects: [{ id: 's1', name: 'Math', emoji: '📐', color: 'indigo', createdAt: 1, updatedAt: 1 }],
    topics: [{ id: 't1', subjectId: 's1', name: 'Algebra', emoji: '📄', order: 1, createdAt: 1, updatedAt: 1 }],
    notes: [
      { ...note([block('text', { content: 'one' })]), id: 'n1', topicId: 't1', title: 'Notes' },
      { ...note([block('text', { content: 'two' })]), id: 'n2', topicId: 't1', title: 'Notes' },
    ],
  }
  const paths = vaultToFiles(vault).map((f) => f.path)
  const md = paths.filter((p) => p.endsWith('.md') && !p.includes('.folder.'))
  assert.equal(new Set(md).size, md.length, 'each note must get its own file')
})
test('filesToTree: reads a flat path map back into subjects and topics', () => {
  const files = new Map([
    ['Physics/Kinematics/Motion.md', '# Speed\n\n- a bullet'],
    ['Physics/Kinematics/Energy.md', 'energy notes'],
    ['Physics.folder.md', 'ignored'],
    ['notes.vault.json', '{}'],
  ])
  const tree = filesToTree(files)
  assert.equal(tree.subjects.length, 1)
  assert.equal(tree.subjects[0]!.topics[0]!.notes[0]!.title, 'Energy')
  assert.equal(tree.subjects[0]!.name, 'Physics')
  assert.equal(tree.subjects[0]!.topics[0]!.notes.length, 2)
  assert.equal(tree.subjects[0]!.topics[0]!.notes[0]!.title, 'Energy')
})
test('treeToVault: imported tree produces usable subjects, topics and notes', () => {
  const tree = filesToTree(new Map([['Bio/Cells/Intro.md', '## The cell\n\n- part a\n- [ ] read paper']]))
  const vault = treeToVault(tree)
  assert.equal(vault.subjects.length, 1)
  assert.equal(vault.topics.length, 1)
  assert.equal(vault.notes.length, 1)
  assert.equal(vault.notes[0]!.topicId, vault.topics[0]!.id)
  assert.deepEqual(vault.notes[0]!.blocks.map((b) => b.type), ['h2', 'bulleted', 'todo'])
  assert.deepEqual(vault.notes[0]!.blocks.map((b) => b.type)[2], 'todo')
})

/* ------------------------------------------------------------------ links */
test('linkInfo: classifies videos, papers and reads', () => {
  assert.equal(linkInfo('https://youtu.be/dQw4w9WgXcQ').kind, 'video')
  assert.equal(linkInfo('https://www.youtube.com/watch?v=dQw4w9WgXcQ').videoId, 'dQw4w9WgXcQ')
  assert.equal(linkInfo('https://arxiv.org/abs/1706.03762').kind, 'paper')
  assert.equal(linkInfo('https://example.com/blog/post').kind, 'article')
  assert.equal(linkInfo('example.com/thing').url, 'https://example.com/thing')
})
test('linkInfo: youtube embeds get a no-cookie player and a poster', () => {
  const info = linkInfo('https://www.youtube.com/watch?v=fNk_zzaMoSs')
  assert.equal(info.embedUrl, 'https://www.youtube-nocookie.com/embed/fNk_zzaMoSs')
  assert.equal(info.poster, 'https://i.ytimg.com/vi/fNk_zzaMoSs/hqdefault.jpg')
})
test('linkInfo: a non-video link gets no embed', () => {
  assert.equal(linkInfo('https://en.wikipedia.org/wiki/Vector').embedUrl, undefined)
})

/* ---------------------------------------------------------------- search */
test('search: Italian stems collapse plural/verb forms', () => {
  assert.equal(stem('funzioni'), stem('funzione'))
  assert.equal(stem('derivate'), stem('derivata'))
  assert.notEqual(stem('cane'), stem('catasta'))
  assert.notEqual(stem('libreria'), stem('libro'))
  // stopwords never reach the index, so they cannot pollute a query
  assert.deepEqual(tokenize('la e di che'), [])
})
test('search: accents and case are folded away', () => {
  assert.deepEqual(tokenize('Energía Elettrica  È'), tokenize('energia elettrica e'))
})
test('search: BM25 ranks the page that actually talks about the term', () => {
  const idx = buildIndex([
    { n: 1, text: 'La fotosintesi clorofilliana avviene nei cloroplasti e produce glucosio.' },
    { n: 2, text: 'Capitolo sulle derivate: la derivata di una funzione e la sua interpretazione geometrica.' },
    { n: 3, text: 'Note sparse su storia medievale, feudalesimo e comuni.' },
  ])
  const hits = idx.search('derivata funzione', 5)
  assert.ok(hits.length > 0)
  assert.equal(hits[0]!.page, 2, `expected page 2 first, got ${hits.map((h) => h.page + ':' + h.score.toFixed(2)).join(' ')}`)
  assert.ok(hits[0]!.score > 0)
})
test('search: a stopword-only query returns nothing instead of everything', () => {
  const idx = buildIndex([{ n: 1, text: 'Il cosa come questo quella' }])
  assert.deepEqual(idx.search('il e la di che', 5), [])
})
test('search: chunks overlap so a sentence on the seam is still found', () => {
  const text = `${'a'.repeat(1300)} parabola ${'b'.repeat(1300)}`
  const chunks = chunkPage(7, text)
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.some((c) => /parabola/.test(c.text)), 'the keyword must live in at least one chunk')
  assert.ok(chunks.every((c) => c.page === 7))
})
test('search: citations carry the page number for the jump', () => {
  assert.equal(citePage('Fisica', 128), 'Fisica, p. 128')
})

/* ------------------------------------------------------------- pdf / ocr */
test('pdf: lines are rebuilt from text items, hyphens glued back', () => {
  const items = [
    { str: 'La temperatura del si', transform: [1, 0, 0, 1, 10, 700] },
    { str: 'stema aumenta', transform: [1, 0, 0, 1, 120, 700] },
    { str: 'di un grado.', transform: [1, 0, 0, 1, 240, 700] },
    { str: 'Seconda riga del paragrafo', transform: [1, 0, 0, 1, 10, 680] },
  ]
  const text = pdfItemsToText(items)
  assert.ok(text.includes('sistema'), `hyphenated word should be glued: ${JSON.stringify(text)}`)
  assert.equal(text.split('\n').length, 2)
})
test('ocr: control noise is stripped, line breaks inside a paragraph are not', () => {
  const dirty = '   La   cinematica \n studia  il   moto.\n\n\nFine  .\n'
  const clean = cleanOcr(dirty)
  assert.ok(!/  /.test(clean), 'double spaces must be collapsed')
  assert.ok(!/\\n\\n\\n/.test(clean), 'blank runs must collapse')
  assert.ok(clean.includes('cinematica'))
})

/* --------------------------------------------------------------- ink */
test('ink: points pack and unpack losslessly', () => {
  const pts = [
    { x: 0.1, y: 0.2, p: 0.5 },
    { x: 0.9, y: 0.75, p: 1 },
    { x: 0, y: 1, p: 0.2 },
  ]
  const packed = packPoints(pts)
  assert.deepEqual(unpackPoints(packed).map((q) => [q.x, q.y, q.p]), pts.map((q) => [q.x, q.y, q.p]))
})
test('ink: svg round-trip keeps tool, colour, width and geometry', () => {
  const strokes: InkStroke[] = [
    { t: 'pen', c: '#0a84ff', w: 1.6, d: packPoints([{ x: 0.1, y: 0.2, p: 0.5 }, { x: 0.4, y: 0.6, p: 0.9 }]) },
    { t: 'highlight', c: PALETTE[4]!.c, w: 2.4, d: packPoints([{ x: 0.2, y: 0.3, p: 1 }, { x: 0.8, y: 0.3, p: 1 }]) },
  ]
  const svg = inkToSvg(strokes)
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'))
  const back = svgToInk(svg)
  assert.equal(back.length, 2)
  assert.equal(back[0]!.t, 'pen')
  assert.equal(back[1]!.t, 'highlight')
  assert.equal(back[0]!.c, '#0a84ff')
  assert.ok(Math.abs(back[0]!.w - 1.6) < 0.2, `width survived badly: ${back[0]!.w}`)
  assert.ok(Math.abs(back[0]!.d[0]! - strokes[0]!.d[0]!) < 1.5, 'x is in the same place')
})
test('ink: paths are one polyline per stroke and scale with pressure', () => {
  const strokes: InkStroke[] = [{ t: 'pen', c: '#1d1d1f', w: 1, d: packPoints([{ x: 0, y: 0, p: 0.2 }, { x: 0.5, y: 0.5, p: 1 }, { x: 1, y: 0.2, p: 0.4 }]) }]
  const pieces = strokePaths(strokes[0]!)
  assert.ok(pieces.length >= 1)
  assert.ok(pieces.every((pc) => pc.d.startsWith('M')), 'every piece starts at a point')
  assert.ok(pieces.every((pc) => pc.w > 0), 'pressure gives each piece a width')
})
test('ink: the eraser removes whole strokes, not pixels', () => {
  const a: InkStroke = { t: 'pen', c: '#1d1d1f', w: 1, d: packPoints([{ x: 0.1, y: 0.1, p: 1 }, { x: 0.2, y: 0.2, p: 1 }]) }
  const b: InkStroke = { t: 'pen', c: '#1d1d1f', w: 1, d: packPoints([{ x: 0.8, y: 0.8, p: 1 }, { x: 0.9, y: 0.9, p: 1 }]) }
  const left = eraseAt([a, b], 0.12, 0.12, 0.03)
  assert.equal(left.length, 1)
  assert.equal(left[0], b)
})
test('ink: empty drawings export as nothing', () => {
  assert.equal(inkToSvg([]), '')
  assert.deepEqual(svgToInk(''), [])
})

/* ------------------------------------------------- new blocks in markdown */
test('md: a handwriting block survives the trip to disk', () => {
  const strokes: InkStroke[] = [{ t: 'pen', c: '#1d1d1f', w: 1.2, d: packPoints([{ x: 0.2, y: 0.3, p: 0.7 }, { x: 0.5, y: 0.9, p: 1 }]) }]
  const md = blockToMd(block('ink', { strokes }))
  const back = mdToBlocks(md)
  assert.equal(back.length, 1)
  assert.equal(back[0]!.type, 'ink')
  assert.equal(back[0]!.strokes?.length, 1)
  assert.ok(Math.abs((back[0]!.strokes?.[0]?.d[0] ?? 0) - strokes[0]!.d[0]!) < 1.5)
})
test('md: a textbook page block keeps its book and page number', () => {
  const md = blockToMd(block('page', { bookId: 'k_42', pageNumber: 128, label: 'Fisica blu' }))
  assert.match(md, /📖 libro: k_42 \| pagina: 128 \| Fisica blu/)
  const back = mdToBlocks(md)
  assert.equal(back.length, 1)
  assert.equal(back[0]!.type, 'page')
  assert.equal(back[0]!.bookId, 'k_42')
  assert.equal(back[0]!.pageNumber, 128)
  assert.equal(back[0]!.label, 'Fisica blu')
})
test('md: a page block with annotations exports the ink too', () => {
  const ink: InkStroke[] = [{ t: 'highlight', c: '#ffd43b', w: 2, d: packPoints([{ x: 0.1, y: 0.4, p: 1 }, { x: 0.6, y: 0.4, p: 1 }]) }]
  const md = blockToMd(block('page', { bookId: 'k_1', pageNumber: 3, label: 'Libro', ink }))
  const back = mdToBlocks(md)
  assert.equal(back[0]!.type, 'page')
  assert.equal(back[0]!.ink?.length, 1)
  assert.equal(back[0]!.ink?.[0]?.t, 'highlight')
})
test('md: an empty page block writes nothing', () => {
  assert.equal(blockToMd(block('page', {})), '')
})

/* ------------------------------------------------- screenshots -> notes */
test('scan: transcript blocks are split per image, even when the label drifts', () => {
  const raw = '=== 1 ===\nLa derivata misura la pendenza.\n=== pagina 2 ===\nf(x) = x^2\n=== 3 ===\nesempi in coda'
  assert.deepEqual(splitTranscript(raw, 3), ['La derivata misura la pendenza.', 'f(x) = x^2', 'esempi in coda'])
})
test('scan: a model that ignores the format still yields its text', () => {
  const parts = splitTranscript('tutto in un pezzo solo, senza numeri', 4)
  assert.equal(parts.length, 4)
  assert.match(parts[0]!, /tutto in un pezzo/)
})
test('scan: empty images stay empty instead of stealing the next block', () => {
  const parts = splitTranscript('=== 1 ===\n\n=== 2 ===\nciao', 3)
  assert.deepEqual(parts, ['', 'ciao', ''])
})
test('scan: effort dials really change the work, not just the label', () => {
  assert.equal(EFFORT.veloce.maxImages, 8)
  assert.equal(EFFORT.standard.maxImages, 0, 'standard must look at every image')
  assert.ok(EFFORT.profondo.maxTokens > EFFORT.standard.maxTokens)
  assert.ok(EFFORT.veloce.minMinutes < EFFORT.standard.minMinutes)
  assert.equal(EFFORT.veloce.allowWeb, false, 'the fast dial never touches the web')
  assert.equal(EFFORT.veloce.cards, false)
})
test('scan: the time budget means leftover time is used, then given up', () => {
  assert.equal(shouldEnrich({ elapsedMs: 10_000, minutes: 4, auto: true, requested: true }), true)
  assert.equal(shouldEnrich({ elapsedMs: 200_000, minutes: 4, auto: true, requested: true }), false, 'past 60% of the budget we stop, even in auto')
  assert.equal(shouldEnrich({ elapsedMs: 600_000, minutes: 4, auto: false, requested: true }), true, 'a hard minimum keeps working')
  assert.equal(shouldEnrich({ elapsedMs: 0, minutes: 4, auto: true, requested: false }), false, 'no cards if the dial says no')
  assert.equal(shouldEnrich({ elapsedMs: 0, minutes: 0, auto: true, requested: true }), true, 'no budget = enrich as long as you like')
})
test('scan: a search phrase is allowed, a URL never is', () => {
  assert.equal(sanitiseQuery('YT: derivata geometrica lezione'), 'derivata geometrica lezione')
  assert.equal(sanitiseQuery('QUERY =  auto e derivate '), 'auto e derivate')
  assert.equal(sanitiseQuery('guarda https://youtube.com/watch?v=x'), null)
  assert.equal(sanitiseQuery('www.youtube.com/results?q=test'), null)
  assert.equal(sanitiseQuery('<img src=x onerror=1>'), null)
  assert.equal(sanitiseQuery('solo'), null, 'one-word queries are too vague to be worth a click')
  assert.equal(sanitiseQuery('cartella/../../etc/passwd'), null)
})
test('scan: only YT: lines become links, and only through the search page', () => {
  const raw = ['YT: teorema di Taylor', ' yt : derivate delle funzioni notevoli', '- YT: integrali definiti', 'YT: https://evil.example/p', 'guarda questo video', 'YT: un'].join('\n')
  const qs = extractQueries(raw)
  assert.deepEqual(qs, ['teorema di Taylor', 'derivate delle funzioni notevoli', 'integrali definiti'])
  assert.equal(ytSearchUrl('teorema di Taylor'), 'https://www.youtube.com/results?search_query=teorema%20di%20Taylor')
  assert.ok(!ytSearchUrl('a b').includes('&'), 'nothing but the query is sent')
})
test('scan: nothing in the writing prompts can reach the web', () => {
  const src = readSource('src/core/screenshot.ts')
  assert.ok(src.includes('localhost'), 'the local-only guard disappeared')
  assert.ok(src.includes('Nessun accesso a internet'), 'the chat system prompt lost its no-network line')
  assert.ok(!/fetch\s*\(\s*['"`]https?:/.test(src), 'a hardcoded remote URL appeared in the scan engine')
  assert.ok(src.includes('localhost') && src.includes('127'), 'the local-only endpoint guard disappeared')
  for (const bad of ['fetch(', 'XMLHttpRequest', 'import(']) {
    const hits = (src.match(new RegExp(bad.replace(/[.()\\[\]]/g, '\\$&'), 'g')) ?? []).length
    assert.ok(hits <= 2, `the scan engine grew too many network calls (${bad}: ${hits})`)
  }
  assert.ok(!/api\.groq|generativelanguage|openrouter|api\.openai|googleapis/.test(src), 'a cloud AI endpoint leaked into the scan engine')
})
test('scan: a non-local endpoint is refused before any request is made', async () => {
  const res = await chat({
    model: 'x',
    text: 'ciao',
    config: { endpoint: 'https://api.groq.com/openai/v1', model: 'x', vision: '', useVision: false, language: 'italiano', contextChars: 9000, studyAhead: false, studyAheadBatch: 6, temperature: 0.2 },
    maxTokens: 100,
  })
  assert.match(res.error ?? '', /può girare solo sul tuo PC/)
})

/* -------------------------------------------------- the study digests */
test('study: the digest parser is forgiving about how the model decorates labels', () => {
  const raw = '**IDEATUTTI:**\n- la derivata è un limite\n* DEFINIZIONI\npendenza = rapporto incrementale\n**Domande**\n1) perché è un limite?\nCOLLEGAMENTI:'
  const d = parseDigest(raw)
  assert.deepEqual(d.keyIdeas, ['la derivata è un limite'])
  assert.deepEqual(d.definitions, ['pendenza = rapporto incrementale'])
  assert.deepEqual(d.examQuestions, ['perché è un limite?'])
  assert.deepEqual(d.links, [])
})
test('study: a digest renders as markdown with page citations', () => {
  const md = digestToMd({ keyIdeas: ['a'], definitions: ['b = c'], examQuestions: [], links: ['d'] }, 12)
  assert.match(md, /\*\*Idee\*\* \(p\. 12\)/)
  assert.match(md, /- b = c/)
  assert.ok(!md.includes('Domande'), 'empty sections must not be printed')
})

/* ------------------------------------------- scan -> blocks (the UI mapping) */
test('scan: markdown from the model becomes real blocks, not one blob of text', () => {
  const md = [
    '# Limite di una funzione',
    '',
    'Definizione con epsilon e delta.',
    '',
    '> [!NOTE] Il valore in x0 non conta.',
    '',
    '- **continuita**: limite = valore',
    '1. primo',
    '2. secondo',
    '- [x] fatto',
    '- [ ] da fare',
    '> citazione',
    '',
    '```',
    'lim x->0 = 1',
    '```',
    '',
    '---',
  ].join('\n')
  const bs = blockify(md)
  assert.deepEqual(bs.map((b) => b.type), ['h1', 'text', 'callout', 'bulleted', 'numbered', 'numbered', 'todo', 'todo', 'quote', 'code', 'divider'])
  assert.equal(bs[0].content, 'Limite di una funzione')
  assert.equal(bs[2].content, '\u{1F4A1} Il valore in x0 non conta.', 'callout keeps the marker md.ts looks for')
  assert.equal(bs[6].checked, true, 'checked box lost its state')
  assert.equal(bs[7].checked, false)
  assert.equal(bs[9].content, 'lim x->0 = 1', 'a code fence should become one code block')
})

test('scan: appended notes sit under the open note (headings bumped, nothing invented)', () => {
  const bs = blockify('## Titoli\ntesto', { plus: 1 })
  assert.deepEqual(bs.map((b) => b.type), ['h3', 'text'])
  assert.equal(bs[0].content, 'Titoli')
  assert.equal(blockify('   \n\n  ').length, 0, 'blank output stays blank')
})

/* -------------------------------------------------------------- run them */
let failed = 0
const main = async () => {
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${name}`)
    console.log(`       ${(err as Error).message.split('\n').slice(0, 6).join('\n       ')}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed${failed ? ` · ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
}
void main()
