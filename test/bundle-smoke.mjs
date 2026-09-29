/**
 * Bundles the app for the jsdom smoke test.
 *
 * Vite understands `?url` imports (they become an emitted asset URL); esbuild does not,
 * so we teach it here: the asset is copied to test/.tmp/ and the module exports its URL.
 * pdf.js and tesseract.js stay behind the dynamic import in src/core/import.ts, so the
 * smoke test never runs them — it only needs the app to boot.
 */
import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
mkdirSync(join(root, 'test/.tmp'), { recursive: true })

/** Maps a package subpath to its real file on disk. */
const resolveAsset = (spec) => {
  if (spec.startsWith('.') || spec.startsWith('/')) return resolve(root, spec)
  const [pkg, ...rest] = spec.split('/')
  const name = spec.startsWith('@') ? `${pkg}/${rest.shift()}` : pkg
  const sub = rest.join('/')
  const entry = require.resolve(`${name}${sub ? `/${sub}` : ''}`)
  return entry
}

const urlPlugin = {
  name: 'vite-url-imports',
  setup(b) {
    b.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: 'asset-url' }))
    b.onLoad({ filter: /.*/, namespace: 'asset-url' }, (args) => {
      const spec = args.path.replace(/\?url$/, '')
      const file = resolveAsset(spec)
      const outName = `${spec.replace(/[^a-z0-9.]+/gi, '_')}`
      copyFileSync(file, join(root, 'test/.tmp', outName))
      return { contents: `export default ${JSON.stringify('/test/.tmp/' + outName)}`, loader: 'js' }
    })
  },
}

await build({
  entryPoints: [join(root, 'test/entry.ts')],
  bundle: true,
  outfile: join(root, 'test/.tmp/app.cjs'),
  format: 'cjs',
  platform: 'browser',
  loader: { '.css': 'text' },
  define: { 'import.meta.env.PROD': 'false' },
  logLevel: 'error',
  plugins: [urlPlugin],
  external: ['fs', 'path'],
})
void dirname
console.log('  bundled for smoke')
