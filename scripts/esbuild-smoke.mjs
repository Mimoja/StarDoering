// Bundles a smoke script for plain node (handles Vite-style "?raw" imports). Usage: node scripts/esbuild-smoke.mjs <entry.ts> <out.cjs>
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const [entry, outfile] = process.argv.slice(2)
const rawPlugin = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw' }))
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }))
  }
}
await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], tsconfig: 'tsconfig.node.json', logLevel: 'warning', plugins: [rawPlugin] })
