# Roadmap

Deliberately short. v0.1 is usable for real note-taking; everything below is a next step, not a missing piece.

## v0.2 — polish the loop you use most
- [ ] `[[note title]]` autocomplete to link notes to each other, plus a "backlinks" strip at the bottom of a note.
- [ ] Drag a note card onto another subject tab to move it (the drag plumbing is already there for the sidebar).
- [ ] Per-block context menu entry: "copy link to this block" (deep link via `#hash` + block id).
- [ ] Remembered caret position per note, so reopening lands where you left off.
- [ ] Word-count goal / study-session timer per subject (optional, off by default).

## v0.2.6 — shipped: screenshots → notes, study ahead

- `Ctrl+Shift+S`: pile of screenshots -> local transcript (vision model, or Tesseract) -> notes,
  with three thinking dials that change image cap / batches / passes / token budget.
- Minimum-time budget: leftover minutes buy a "what would make studying easier" pass, capped at
  60% of the budget in auto mode; hard minimum if auto is off.
- Notes are built only from the images: prompts carry no URL, non-local endpoints are refused
  before fetch (unit-tested), and the transcript stays editable with a re-generate button.
- Optional, off by default: <=4 `YT:` search phrases -> plain YouTube search links, filtered to
  words only (no URLs, no markup). The app never opens or reads them.
- Result lands in a note as real blocks (flashcards -> toggles), or appended to the open note.
- Study ahead: local model reads pages near you into per-page digests (ideas/definitions/questions/
  links), stored in `digests`, and used as context for later answers; stop/pause/clear from the reader.

## v0.2.5 — shipped: textbooks, local AI, pen

- Book/Page data model + Dexie v3, four import doors (EPUB with a hand-rolled zip reader, PDF via pdf.js, page images, blank paste-per-page).
- Local OCR with the Italian `traineddata` vendored in `public/tessdata/`, so nothing downloads at runtime.
- BM25 search over books with an Italian stemmer; page chunks with overlap; citations that jump.
- Ollama-only AI (keyless, `fetch`, streaming) with an honest retrieval-only fallback; vision optional.
- Vector pen on pages and inside notes, exported to SVG; reader side pane with Testo/Appunti/AI/Cerca.
- Per-book Markdown export to a synced folder (`Titolo/pagine/0001.md`).

## v0.3 — content types
- [ ] Tables (block type `table`, Markdown pipe tables, `Tab` between cells).
- [ ] Math: inline `$…$` and a `math` block rendered by KaTeX, stored as LaTeX in the `.md` so it survives export.
- [ ] PDF attachment block pointing at files inside the vault folder rather than base64.
- [ ] Flashcard block: `Q | A` pairs that also render as a review mode for the whole topic.

## v0.4 — getting it onto the phone properly
- [ ] PWA install onboarding screen (install button, offline check, "add to home screen" hints).
- [ ] Web Share Target: share a YouTube link from the phone browser straight into a chosen topic. Needs an HTTPS origin, so this is where self-hosting or a free static host comes in.
- [ ] Two-way folder sync with conflict detection: compare `notes.vault.json` timestamps, and ask instead of clobbering when both sides changed.
- [ ] Optional git adapter: auto-commit the vault folder to a private repo, so you get history and a second backup for free.

## v0.5 — if you ever want real-time
- [ ] Supabase (free tier) behind the same `core/db.ts` interface: rows become a remote mirror, IndexedDB stays the cache. Only worth it if two-device simultaneous editing actually becomes a problem.

## Things I would not build
- Account system, collaboration, comments, sync-as-a-service. You are one person on two devices; a folder of Markdown and Syncthing is less work forever than a backend.
