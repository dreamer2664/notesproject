// Single bundle for the smoke test, so the app, the DB and the markdown layer are all the
// same module instances as the ones jsdom is running. No second realm, no stubs.
import '../src/main'
import { exportVault } from '../src/core/db'
import { noteToMd, vaultToFiles } from '../src/core/md'
import { openImport } from '../src/ui/books'

// esbuild's browser/CJS output does not surface entry exports, so hand them to the harness.
;(window as unknown as { __notesTest: unknown }).__notesTest = { exportVault, noteToMd, vaultToFiles, openImport }
