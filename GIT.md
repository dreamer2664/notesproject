# Getting the code onto your own machine

The code lives at `https://github.com/dreamer2664/notesproject` (branch `main`).

## First time, on your PC

```powershell
git clone https://github.com/dreamer2664/notesproject.git
cd notesproject
npm install
npm run dev
```

Open <http://localhost:5173>. That's the whole setup. Nothing else has to be running:
no database, no server, no account. Your notes go into that browser profile's IndexedDB.

To check the project the way CI would:

```powershell
npm run typecheck   # tsc --noEmit
npm test            # 21 node tests for the Markdown layer + a jsdom smoke test of the whole app
npm run build       # typecheck, then a production bundle in dist/
```

`npm run build && npm run preview` serves the real production bundle if you want to see it
without Vite's dev overlay.

## Every time after that

```powershell
git add -A
git commit -m "what changed"
git push
```

`git push` will ask for a credential. Two options, pick one:

- **Git Credential Manager (easiest).** If you have GitHub Desktop or recent Git for Windows,
  it pops open a browser sign-in once and remembers it.
- **A fine-grained PAT (if you'd rather paste a token).** GitHub → Settings → Developer settings →
  Fine-grained tokens → Generate new token. Give it **only**: *Account → Follow (read)* is not even
  needed; what you want is *Repository access → Only select repositories → notesproject*, and
  *Contents: Read and write*. Set an expiry. Then `git push` with username `dreamer2664` and that
  token as the password.

**Please make the repo private** before putting anything personal in it: repo → Settings →
*Change visibility* → Private. (Right now it is public: `raw.githubusercontent.com` returns
`200` for the README with no authentication. The code itself is harmless to publish, but if this
repo later holds an exported copy of your actual notes, it should not be readable by anyone.)

**If you pasted a token into a chat or a terminal history, revoke it afterwards** —
Settings → Developer settings → Fine-grained tokens → *the token* → Revoke, then make a fresh one.
Tokens that have appeared in plaintext are best treated as burned. This repo contains no token:
`.github-token` and `test/.tmp` are in `.gitignore`.

## Keeping a private remote but still using this folder

If you'd rather not use the repo I pushed to:

```powershell
git remote set-url origin https://github.com/your-name/your-new-repo.git
git push -u origin main
```

## Where to go in the code

| You want to change | File |
| --- | --- |
| Colours, spacing, fonts, dark mode | `src/styles.css` (token block at the top) |
| Seed / default content on first run | `src/core/db.ts` → `seedIfEmpty()` |
| A block type's behaviour in the editor | `src/editor/editor.ts` (`bodyFor`, `SLASH`) |
| How notes map to Markdown | `src/core/md.ts` |
| Where data is stored | `src/core/db.ts` (IndexedDB) + `src/core/fs.ts` (folder archive) |
| Layout of the dashboard / sidebar / tabs | `src/ui/views.ts`, `src/ui/shell.ts` |

Start with `src/main.ts`: it is ~120 lines and shows exactly how a hash becomes a screen.
