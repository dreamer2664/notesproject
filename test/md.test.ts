/**
 * Run: npm test
 * Bundles this file with esbuild (already a Vite dependency) and runs it in node,
 * so the real md.ts / fs.ts code paths are exercised — no re-implemented logic.
 */
import assert from 'node:assert/strict'
import { blockToMd, mdToBlocks, noteToMd, treeToVault, vaultToFiles, inlineToMd } from '../src/core/md'
import { filesToTree, linkInfo } from '../src/core/fs'
import type { Block, Note } from '../src/core/types'

let n = 0
const block = (type: Block['type'], extra: Partial<Block> = {}): Block => ({ id: `b${++n}`, type, ...extra })
const note = (blocks: Block[]): Note => ({ id: 'n1', topicId: 't1', title: 'Test note', icon: '📝', blocks, createdAt: 1, updatedAt: 1 })

const tests: [string, () => void][] = []
const test = (name: string, fn: () => void) => tests.push([name, fn])

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

/* -------------------------------------------------------------- run them */
let failed = 0
for (const [name, fn] of tests) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${name}`)
    console.log(`       ${(err as Error).message.split('\n').slice(0, 6).join('\n       ')}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed${failed ? ` · ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
