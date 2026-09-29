# Notes

A personal, Notion-shaped notes app with an Obsidian-style organising model: **Subjects → Topics → Notes**.
Local-first, no account, no server, no tracking. Light and dark, keyboard-driven, works on PC and phone.

```
npm install
npm run dev        # http://localhost:5173
```

Other commands: `npm run build` (typecheck + production bundle), `npm test` (38 unit tests + a jsdom smoke test that boots the real app, reader and all), `npm run typecheck`.

---

## What it does

**Three levels, always.** Big tabs across the top are subjects (one per field you're studying). The left sidebar holds that subject's topics, with notes nested underneath. That's the whole navigation model — no infinite tree to lose things in.

**A block editor, not a text area.** `Enter` makes a new block. `/` on an empty block opens a command menu: headings, bulleted / numbered / to-do lists, toggles, quotes, callouts, code, dividers, images, links. Type `# `, `- `, `1. `, `> `, `[] ` to convert a block. Hover a block to get the `+` and the `⠿` grip — drag the grip to move it, click it for duplicate / delete / turn-into. `Tab` / `Shift+Tab` indent. `Alt+↑/↓` move a block. Paste an image or a pile of HTML from Notion and it becomes proper blocks, not one blob.

**Links are first-class.** A `/link` becomes a card: favicon, host, a type badge (`video` / `article` / `paper` / `doc`), a title you can edit, a URL field, and a "why I saved this" line. YouTube and Vimeo links get a click-to-load player (nothing loads until you click, so notes open fast and nothing phones home). `⌘⇧L` saves a link from your clipboard into the note you're reading. Every link is also listed at the bottom of the note under **References**, and everything you've ever saved appears in **Library of links** with filters for videos / reading / unread / starred.

**⌘K (Ctrl+K)** searches every note and runs commands. `/` outside a note jumps into the editor.

**Two appearances.** Follows your system setting, or pin one from the sidebar. Colours, spacing and fonts are all in one file — see *Theming* below.

**Textbooks are a first-class content type.** `Ctrl+Shift+B` opens the import dialog: drop an EPUB (the one Adobe Digital Editions / laZ / "libro liquido" hand you), a PDF, or a folder of page images. Pages become image + text, with **local OCR** (Italian model vendored inside the app, so it works with the wifi off). The reader is split-screen — page on the left, `Testo / Appunti / AI / Cerca` on the right — and `p` gives you a pen that writes on the page itself. See [`docs/LIBRI-AI-PENNA.md`](docs/LIBRI-AI-PENNA.md) (Italian) for the per-publisher how-to.

**AI with no key, no cloud, no bill.** The AI tab talks to **Ollama on your own machine** (`127.0.0.1:11434`) — no API key, no account, nothing leaves the PC. Retrieval is done in-app (BM25 over the book, Italian stemmer), so the model gets the pages that actually matter, with page numbers that are clickable in the answer. No model installed? The tab still answers honestly by quoting the book.

**Your files are the archive.** Export writes a folder of plain `.md` files: `Subject/Topic/Note.md`, plus `notes.vault.json` (ids, icons, order) and a `README.txt`. Nothing is locked in. Import reads that folder back.

---

## Data: where it lives, and how it reaches your phone

The app writes to **IndexedDB in your browser** — that is the live copy. Everything is offline-first; there is no backend and no login.

For a durable archive and for your phone:

1. Click **Export to folder…** (bottom-left) and pick a folder. Desktop Chrome/Edge can write files directly; the folder handle is remembered, so next time it's **Sync now**, one click.
2. Put that folder somewhere that syncs. Both are free:
   - **Syncthing** (desktop + Android) — no cloud, no account, files go device-to-device on your LAN.
   - **OneDrive** — already on your Windows machine; 5 GB free is far more than text notes need.
3. On the phone, open the app in Chrome (or add it to your home screen — it's a manifest-driven installable web app) and use **Import** to read the synced folder. On Android Chrome this uses the normal folder picker, so it works where the desktop File System Access API doesn't.

If your browser can't write to a folder, **Backup** downloads a single JSON file instead, and **Import** reads it back.

Nothing in the app talks to a server. The only network requests a note can make are for favicons and for a video player you explicitly clicked.

---

## Files

```
src/
  main.ts             boot, hash router, keyboard shortcuts
  styles.css          every design token, both appearances, all responsive rules
  core/
    types.ts          the data model (Subject / Topic / Note / Block / Book / Page / InkStroke)
    db.ts             Dexie (IndexedDB) + every query and mutation, books and pages included
    md.ts             block <-> Markdown, folder tree <-> vault, both directions (ink exports as SVG)
    import.ts         the four doors in: EPUB (own zip reader), PDF (pdf.js), page images + OCR, blank book
    search.ts         BM25 with an Italian stemmer, chunking, snippets, page citations
    ai.ts             Ollama over fetch: config, streaming, context building, retrieval fallback
    ink.ts            vector pen/highlighter/eraser, palm rejection, toolbar, SVG export
    fs.ts             folder read/write (File System Access API + <input> fallback), link detection, image downscaling
    util.ts           ids, sanitising, dates, small text helpers
  ui/
    shell.ts          sidebar + tab bar + outlet + the data strip at the bottom-left
    views.ts          dashboard, subject, topic, sidebar tree, note cards
    note.ts           the note screen: title, meta, editor mount, References panel
    library.ts        cross-subject link library with filters
    reader.ts         the textbook reader: split panes, page ink, search, AI panel, book tools
    books.ts          import dialog, book cards, export-a-book-to-folder
    ai-settings.ts    the Ollama dialog (model, vision, context size), reachable from ⌘K too
    palette.ts        ⌘K search + commands
    actions.ts        every create / rename / move / delete / import / export flow
    dom.ts            element helper, modal, toast, confirm
    icons.ts          inline SVGs
    theme.ts          light / dark / system
  editor/
    editor.ts         the block editor: rows, slash menu, drag, paste, format toolbar
test/
  md.test.ts          Markdown + folder + link tests (runs in node)
  smoke.mjs           boots the whole bundle in jsdom and asserts it renders
public/
  manifest.webmanifest, sw.js, icons  installable + offline
```

## Theming

Open `src/styles.css`. The top block is the whole vocabulary:

```css
--accent: #0a84ff;   /* the one colour that means "active" */
--fg / --fg-2 / --fg-3 / --fg-4     /* ink, at four weights of grey */
--bg / --bg-2 / --bg-3              /* paper, raised, recessed */
--line / --line-strong              /* hairlines, not borders */
--r / --r-sm / --r-lg               /* corner radii */
--side-w: 268px                     /* sidebar width */
--font: -apple-system, …            /* the type stack */
```

`html[data-theme='dark']` overrides just the colours, so dark mode stays a mirror of light mode rather than a second design. Subject accents (`--c-indigo`, `--c-rose`, …) are used as a 2px rule on the dashboard cards and nothing else.

## Adding a block type

Three places, deliberately: `Block['type']` in `core/types.ts`, rendering in `editor/editor.ts` (`bodyFor`) plus the `SLASH` array, and Markdown round-trip in `core/md.ts` (`blockToMd` / `mdToBlocks`). `test/md.test.ts` has a round-trip test to copy.

## Known limits (v0.1)

- One browser profile = one library. IndexedDB is per-origin, so `localhost:5173` on your PC and the same folder on your phone are two separate stores until you sync the folder. No real-time multi-device editing — that would need a server, and you asked for free.
- Images are stored inside the note as data URIs (downscaled to 1600px max). Imported books store page images as data URIs too: a 300-page book is ~40–90 MB of IndexedDB. The reader's **Libro → Togli solo le immagini** keeps the text and frees the space.
- DRM stays out of scope on purpose: no scraping of the publisher's web reader. What publishers hand over as a file (EPUB/PDF/images) is what gets imported; anything else goes through paste-per-page.
- Local AI is as fast as your machine: on an old 8 GB laptop expect 20–60 s per answer, and no AI at all when the app is open on your phone away from the PC (that is what "no server" costs).
- Tables, math (LaTeX), and backlinks between notes are not in yet.
- On iOS Safari the folder read/write API isn't available; use **Backup / Import** with the Files app, or wait for v2 where a share-sheet flow is planned.

## License

Nothing in here is copyleft-encumbered: it's your code, MIT.
