// `electron-vite dev` runs inside node_modules' stock Electron.app, so macOS shows "Electron" in the menu bar
// and dock; renaming the bundle's Info.plist keys fixes that. macOS-only, idempotent, harmless if it fails.
const fs = require('node:fs')
const path = require('node:path')

const NAME = require('../package.json').productName

if (process.platform !== 'darwin') process.exit(0)

try {
  // require('electron') resolves to .../Electron.app/Contents/MacOS/Electron
  const plist = path.resolve(require('electron'), '..', '..', 'Info.plist')
  const before = fs.readFileSync(plist, 'utf8')
  const after = before.replace(
    /(<key>CFBundle(?:Display)?Name<\/key>\s*<string>)[^<]*(<\/string>)/g,
    `$1${NAME}$2`
  )
  if (after === before) process.exit(0)
  fs.writeFileSync(plist, after)
  // Nudge LaunchServices so it re-reads the bundle instead of serving its cache.
  fs.utimesSync(path.resolve(plist, '..', '..'), new Date(), new Date())
  console.log(`dev Electron.app renamed to ${NAME}`)
} catch (err) {
  console.warn(`could not rename the dev Electron.app: ${err.message}`)
}
