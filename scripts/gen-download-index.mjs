/**
 * Writes dist/index.html: what `python3 -m http.server` in dist/ serves to a Steam Deck or any
 * other machine on the network. Lists the artifacts that are actually there and carries the
 * stardoering:// link that adds the mod list as a profile.
 *
 * Run after a build:  npm run index
 * Override the repository:  STARDOERING_MODS_REPO=https://github.com/you/mods.git npm run index
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const outFile = path.join(distDir, 'index.html')

const REPO = process.env.STARDOERING_MODS_REPO ?? 'https://github.com/Mimoja/StarDoeringMods.git'
const BRANCH = process.env.STARDOERING_MODS_BRANCH ?? 'main'

/** Installable artifacts only – the unpacked folders and build leftovers are noise here. */
const KINDS = ['.AppImage', '.deb', '.dmg', '.exe', '.zip']

/** What a file is for, so nobody grabs the arm64 build for a Deck. */
function label(name) {
  const arm = /arm64|aarch64/i.test(name)
  if (name.endsWith('.AppImage')) return arm ? 'Linux · arm64' : 'Linux · Steam Deck'
  if (name.endsWith('.deb')) return arm ? 'Debian / Ubuntu · arm64' : 'Debian / Ubuntu'
  if (name.endsWith('.dmg')) return arm ? 'macOS · Apple Silicon' : 'macOS · Intel'
  if (name.endsWith('.zip')) return `macOS · ${arm ? 'Apple Silicon' : 'Intel'} · archive`
  if (name.endsWith('.exe')) return 'Windows'
  return ''
}

/** Same shape as the app's buildProfileLink(): readable when it can be, encoded when it must be. */
function profileLink(url, branch) {
  const safe = (v) => (/^[\w.:/@+-]+$/.test(v) ? v : encodeURIComponent(v))
  return `stardoering://add-profile?url=${safe(url.trim())}&branch=${safe(branch.trim())}`
}

/** github.com/you/mods.git → the browsable page. */
function repoPage(url) {
  const https = url.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '')
  return /^https?:\/\//.test(https) ? https : `https://${https}`
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['kB', 'MB', 'GB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

async function listArtifacts() {
  const entries = await fs.readdir(distDir, { withFileTypes: true })
  const files = []
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!KINDS.some((ext) => e.name.endsWith(ext))) continue
    const stat = await fs.stat(path.join(distDir, e.name))
    files.push({ name: e.name, label: label(e.name), size: stat.size, mtime: stat.mtime })
  }
  // Newest first, so the build you just made is at the top.
  return files.sort((a, b) => b.mtime - a.mtime)
}

function render(files) {
  const link = profileLink(REPO, BRANCH)
  const rows = files.length
    ? files
        .map(
          (f) => `      <li>
        <a href="${escape(encodeURIComponent(f.name))}" download>${escape(f.name)}</a>
        <span class="meta">${escape(f.label)} · ${human(f.size)} · ${f.mtime.toISOString().slice(0, 10)}</span>
      </li>`
        )
        .join('\n')
    : '      <li class="empty">No builds in dist/ yet — run <code>npm run dist:appimage</code>.</li>'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StarDöring</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 3rem 1.5rem; background: #121212; color: #e6e6e6;
         font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 44rem; margin: 0 auto; }
  h1 { font-size: 1.6rem; font-weight: 600; margin: 0 0 .25rem; }
  h2 { font-size: .8rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em;
       color: #8a8a8a; margin: 2.5rem 0 .75rem; }
  p { color: #b4b4b4; margin: .4rem 0; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; flex-wrap: wrap; gap: .25rem 1rem; align-items: baseline;
       padding: .7rem 0; border-bottom: 1px solid #262626; }
  li.empty { color: #8a8a8a; display: block; }
  a { color: #7fb2ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .meta { color: #8a8a8a; font-size: .85em; margin-left: auto; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em;
         background: #1e1e1e; padding: .1em .35em; border-radius: 3px; color: #d0d0d0; }
  pre { background: #1a1a1a; border: 1px solid #262626; border-radius: 4px;
        padding: .8rem 1rem; overflow-x: auto; color: #d0d0d0; }
  pre code { background: none; padding: 0; }
  .add { display: inline-block; margin: .3rem 0 .6rem; padding: .55rem 1rem;
         border: 1px solid #3a3a3a; border-radius: 4px; background: #1e1e1e; color: #e6e6e6; }
  .add:hover { background: #262626; text-decoration: none; }
  .url { color: #8a8a8a; font-size: .85em; word-break: break-all; }
</style>
</head>
<body>
<main>
  <h1>StarDöring</h1>
  <p>Stardew Valley launcher &amp; mod manager.</p>

  <h2>Downloads</h2>
  <ul>
${rows}
  </ul>

  <h2>On the Steam Deck</h2>
  <p>Downloads lose the executable bit, so set it before the first start:</p>
  <pre><code>chmod +x StarDoering-*.AppImage
./StarDoering-*.AppImage</code></pre>
  <p>Then use <b>Install to home</b> on the dashboard — it copies the AppImage to
     <code>~/.bin/StarDoering.AppImage</code>, a path that survives moving or deleting the download,
     and that <b>Add to Steam</b> can point at.</p>

  <h2>Mod list</h2>
  <p>With StarDöring already running, this adds the shared mod list as a profile:</p>
  <a class="add" href="${escape(link)}">Add the mod list to StarDöring</a>
  <p class="url">${escape(link)}</p>
  <p>Repository: <a href="${escape(repoPage(REPO))}">${escape(repoPage(REPO))}</a></p>
</main>
</body>
</html>
`
}

const files = await listArtifacts()
await fs.writeFile(outFile, render(files))
console.log(`dist/index.html — ${files.length} artifact${files.length === 1 ? '' : 's'} listed`)
