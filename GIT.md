# Getting the code onto your PC and running it

Repo: `https://github.com/dreamer2664/notesproject` · branch `main` · **public**, so pulling never
asks for a password. Pushing does (see *Push* at the bottom).

Everything below is the same in **PowerShell**, **cmd**, and macOS/Linux **terminal**, except where
a step is marked Windows-only. Copy-paste whole blocks.

---

## 0. Once ever: install two things

You need **Git** and **Node.js 20.19+** (Node 22 LTS is the easy pick). Check first:

```powershell
git --version
node --version
```

If either says *"not recognized"* / *"command not found"*, install it:

| | Windows (PowerShell) | macOS (terminal) | Linux (terminal) |
| --- | --- | --- | --- |
| Git | `winget install --id Git.Git` | comes with Xcode tools: `xcode-select --install` | `sudo apt install git` |
| Node | `winget install --id OpenJS.NodeJS.LTS` | `brew install node@22` | nodesource, or `sudo apt install nodejs npm` |

Close and reopen the terminal after installing — otherwise the new `PATH` isn't picked up and you'll
keep seeing "not recognized".

`node --version` must print `v20.19.x`, `v22.x` or newer. `v18` will run the app but not `npm test`
(the jsdom in devDependencies needs 20.19+).

---

## 1. Pull everything

### First time on this machine (nothing cloned yet)

```powershell
cd $HOME           # macOS/Linux: cd ~
git clone https://github.com/dreamer2664/notesproject.git
cd notesproject
npm install
```

`npm install` is the only slow step the first time (it fetches ~70 packages). After that, `npm install`
finishes in a second.

### Every time after that

```powershell
cd $HOME\notesproject        # macOS/Linux: cd ~/notesproject
git pull
npm install
```

`git pull` updates **only tracked files** — it never touches your notes, because your notes live in
the browser, not in this folder (see *Your data* below).

### Two one-liners that do all of the above

```powershell
# Windows (PowerShell) — clone or pull, install deps, start the app
cd $HOME; if (Test-Path notesproject\.git) { cd notesproject; git pull; npm install } else { git clone https://github.com/dreamer2664/notesproject.git; cd notesproject; npm install }; npm run dev
```

```bash
# macOS / Linux
cd ~ && if [ -d notesproject/.git ]; then cd notesproject && git pull && npm install; else git clone https://github.com/dreamer2664/notesproject.git && cd notesproject && npm install; fi; npm run dev
```

### When `git pull` refuses

| Message you see | What it means | Do this |
| --- | --- | --- |
| `Your local changes to the following files would be overwritten by merge` | you edited a file I also changed | `git stash` → `git pull` → `git stash pop` |
| `fatal: refusing to merge unrelated histories` | history got rewritten on the remote | `git pull --rebase`, or if you don't care about local commits: `git fetch origin && git reset --hard origin/main` |
| `error: cannot pull with rebase: You have unstaged changes` | same as the first row | `git stash` first |
| `fatal: not a git repository` | you're in the wrong folder | `cd notesproject` (check with `dir` / `ls`) |
| `npm ERR! code EACCES` / `EPERM` on install | an editor or antivirus is holding `node_modules` | close VS Code / the running app, then `rmdir /s /q node_modules` (macOS/Linux: `rm -rf node_modules`) and `npm install` again |

If it all goes weird and you just want a clean copy, your **notes survive** — delete the folder, clone
again, reopen the same browser.

### No Git at all, just want the files

Browser → `github.com/dreamer2664/notesproject` → green **Code** → **Download ZIP**, unzip, then
`npm install` inside it.

---

## 2. Start it

```powershell
cd $HOME\notesproject
npm run dev
```

Then open **<http://localhost:5173>**. That's the whole setup: no database, no server, no account,
nothing to sign into. Leave that terminal window open while you work — `Ctrl+C` stops the app.

**Prefer it without a terminal window?** Build once and serve the bundle (a real app, no dev overlay):

```powershell
npm run build
npm run preview      # still http://localhost:5173
```

Both default to port 5173 with `strictPort`, so `preview` refuses to start while `dev` is running —
close the dev terminal first, or move it: `npm run preview -- --port 4173` (then use
<http://localhost:4173>).

**Make it feel like a program:** in Edge/Chrome open `http://localhost:5173` → menu → *Apps* →
*Install this site as an app* (Chrome: `…` → *Save and share* → *Install page as app*). You get an
icon, its own window, and it works with the wifi off.

**On your phone, same wifi:** get the PC's address, then use it with the port.

```powershell
ipconfig | Select-String -Context 0,4 "Wireless|Wi-Fi|Ethernet adapter"   # look for IPv4 Address, e.g. 192.168.1.42
```

phone browser → `http://192.168.1.42:5173`. Windows will pop a firewall prompt the first time — allow
it on *Private networks*. This is the same app but a **separate** IndexedDB, so the phone starts empty;
the real phone story is *export → OneDrive/Syncthing → import* (below).

---

## 3. The parts that need one more program

Everything works except the AI without this. The screenshot/OCR features work offline already (the
Italian OCR data is vendored inside the repo).

- **Ollama** (free, local) — the only thing the AI talks to, always `127.0.0.1:11434`:
  ```powershell
  winget install --id Ollama.Ollama        # or download from ollama.com
  ollama pull qwen2.5:3b                  # text: ~2 GB, fine on 8 GB RAM
  ollama pull qwen2.5vl:3b                # only if you want screenshots *read*, not just OCR'd
  ```
  Ollama installs a background service that starts with Windows; if the app says *Ollama non
  risponde*, run `ollama serve` in another window. On an 8 GB machine stick to `qwen2.5:3b`
  (`1.5b` if it crawls) — the app is built so the model can be swapped in ⚙ settings.
  If you reach the app from another device, Ollama must allow that origin:
  `setx OLLAMA_ORIGINS "*"` (then restart Ollama). Not needed on `localhost`.
- **PDFs / EPUBs / page photos**: drag them into the app (`Ctrl+Shift+B`). Nothing extra to install.
- **OCR of scanned books**: uses the bundled Tesseract `ita.traineddata.gz`, already in `public/`, so
  it works with no network.

---

## 4. Check it works the way CI would

```powershell
npm run typecheck   # tsc --noEmit, no output = good
npm test            # 51 unit tests + a jsdom smoke test that boots the real app (reader, pen, scan dialog, study worker)
npm run build       # typecheck + production bundle in dist/
```

---

## 5. Your data — and the only thing worth knowing about it

Notes live in **IndexedDB inside that browser profile**. Not in the repo folder, not in a file.
Which means:

- `git pull`, `rm -rf node_modules`, even deleting and re-cloning **cannot** touch your notes;
- "Clear browsing data" / a private window / a different browser = the app looks brand new;
- use the same browser every time (the installed-app trick in §2 helps with this).

Backup / move to another machine: in the app, **Export** picks a folder and writes plain Markdown
(`Subject/Topic/Note.md` + `notes.vault.json`) — point that folder at OneDrive or Syncthing and you
have free sync **including to your phone**; **Import** reads that folder back. Note that Import/Export
covers notes; imported books are large, so they re-import from your own PDFs rather than from the vault.

---

## 6. Where to go in the code

| You want to change | File |
| --- | --- |
| Colours, spacing, fonts, dark mode | `src/styles.css` (token block at the top) |
| Book / reader / scan dialogs styling | `src/styles-books.css` (imported from `styles.css` line 1) |
| Seed / default content on first run | `src/core/db.ts` → `seedIfEmpty()` |
| A block type's behaviour in the editor | `src/editor/editor.ts` (`bodyFor`, `SLASH`) |
| How notes map to Markdown | `src/core/md.ts` |
| The screenshot → notes engine (effort dials, prompts, budget) | `src/core/screenshot.ts` |
| The screenshot dialog | `src/ui/scan.ts` |
| Background "study ahead" digests | `src/core/study.ts` |
| Ollama calls, context building, retrieval | `src/core/ai.ts` |
| Where data is stored | `src/core/db.ts` (IndexedDB) + `src/core/fs.ts` (folder archive) |
| Layout of the dashboard / sidebar / tabs | `src/ui/views.ts`, `src/ui/shell.ts` |

Start with `src/main.ts`: it is ~120 lines and shows exactly how a hash becomes a screen.

## 7. Push (only if you change code)

```powershell
git add -A
git commit -m "what changed"
git push
```

- **Git Credential Manager (easiest):** with recent Git for Windows or GitHub Desktop it opens a browser
  sign-in once and remembers it. If you later make the repo private, this is what authenticates you.
- **Fine-grained PAT (if you'd rather paste a token):** GitHub → Settings → Developer settings →
  Fine-grained tokens → Generate new token. Give it *only* Repository access → *notesproject*, and
  *Contents: Read and write*, with an expiry. Then `git push` with username `dreamer2664` and the token
  as the password.

A token that has ever appeared in plaintext (chat, terminal history) should be revoked and replaced.
This repo carries no token: `.github-token` and `test/.tmp` are gitignored, and a `git grep` for the
GitHub token prefix over *every commit in history* returns nothing (that check is how I know — it is
worth re-running after any commit that touches these docs).

**Visibility:** the repo is currently public. The code is harmless to publish, but flip it to Private
(repo → Settings → *Change visibility*) if you ever push real notes into it.
