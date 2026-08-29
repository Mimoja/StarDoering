// Renders resources/icon.svg into the per-platform icon files (`npm run icons`; Electron rasterises, no native deps).
// Windows/Linux get a full-bleed rounded square, macOS the artwork inset in Apple's squircle with the Dock shadow baked in.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const resources = path.join(root, 'resources')
const linuxDir = path.join(resources, 'icons')
const face = fs
  .readFileSync(path.join(resources, 'icon.svg'), 'utf8')
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '')

const SQUARE = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const ICO = [16, 24, 32, 48, 64, 128, 256]
const MAC = [16, 32, 64, 128, 256, 512, 1024]

// Apple's icon shape, as a superellipse (|x/a|^5 + |y/a|^5 = 1) polygon.
function squircle(cx, cy, a, steps = 1440) {
  const pow = 2 / 5
  const pts = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI
    const c = Math.cos(t)
    const s = Math.sin(t)
    const x = cx + a * Math.sign(c) * Math.abs(c) ** pow
    const y = cy + a * Math.sign(s) * Math.abs(s) ** pow
    pts.push(`${x.toFixed(2)} ${y.toFixed(2)}`)
  }
  return `M${pts.join('L')}Z`
}

const page = (svg, size) =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}` +
      `svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
  )

const wrap = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${inner}</svg>`

// Full-bleed rounded square: Windows taskbar, Linux app grids, the favicon.
const squareSvg = wrap(
  `<defs><clipPath id="rr"><rect width="1024" height="1024" rx="190" ry="190"/></clipPath></defs>` +
    `<g clip-path="url(#rr)">${face}</g>`
)

// macOS: 824x824 of artwork centred in 1024, plus the shadow Apple's grid leaves room for.
const macSvg = wrap(
  `<defs><clipPath id="sq"><path d="${squircle(512, 512, 412)}"/></clipPath>` +
    `<filter id="dock" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feDropShadow dx="0" dy="10" stdDeviation="5" flood-color="#000" flood-opacity="0.22"/>` +
    `<feDropShadow dx="0" dy="22" stdDeviation="18" flood-color="#000" flood-opacity="0.20"/>` +
    `</filter></defs>` +
    `<g filter="url(#dock)"><g clip-path="url(#sq)">` +
    `<g transform="translate(100 100) scale(0.8046875)">${face}</g></g></g>`
)

// capturePage works in device pixels, so on a HiDPI screen a CSS pixel is worth
// more than one of them. Probed once, then divided out of every requested size.
let ratio = 1
async function shoot(win, svg, css) {
  await win.loadURL(page(svg, css))
  await win.webContents.executeJavaScript(
    'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'
  )
  return win.webContents.capturePage({ x: 0, y: 0, width: css, height: css })
}

async function render(win, svg, size) {
  const css = size / ratio
  if (!Number.isInteger(css)) throw new Error(`${size}px is not renderable at a ${ratio}x ratio`)
  const img = await shoot(win, svg, css)
  const { width, height } = img.getSize()
  if (width !== size || height !== size) throw new Error(`captured ${width}x${height}, wanted ${size}`)
  return img
}

// BGRA straight-alpha rows, bottom-up, as a 32bpp DIB for an .ico entry.
function bmpEntry(img, size) {
  const src = img.toBitmap()
  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const from = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x++) {
      const i = from + x * 4
      const o = (y * size + x) * 4
      const a = src[i + 3]
      // Chromium hands back premultiplied alpha; Windows wants it straight.
      for (let c = 0; c < 3; c++) xor[o + c] = a === 0 ? 0 : Math.min(255, Math.round((src[i + c] * 255) / a))
      xor[o + 3] = a
    }
  }
  const maskRow = Math.ceil(size / 32) * 4
  const and = Buffer.alloc(maskRow * size)
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR + AND stacked
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(xor.length + and.length, 20)
  return Buffer.concat([header, xor, and])
}

function writeIco(file, entries) {
  const dir = Buffer.alloc(6 + entries.length * 16)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(entries.length, 4)
  let offset = dir.length
  entries.forEach(({ size, data }, i) => {
    const e = 6 + i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, e)
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1)
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  fs.writeFileSync(file, Buffer.concat([dir, ...entries.map((e) => e.data)]))
}

// PNG-payload .icns, for the platforms where `iconutil` does not exist.
function writeIcns(file, pngs) {
  const types = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' }
  const chunks = []
  for (const [size, png] of pngs) {
    const type = types[size]
    if (!type) continue
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(png.length + 8, 4)
    chunks.push(head, png)
  }
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  fs.writeFileSync(file, Buffer.concat([head, body]))
}

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  })

  ratio = (await shoot(win, squareSvg, 64)).getSize().width / 64
  fs.mkdirSync(linuxDir, { recursive: true })

  // Windows + Linux + in-app.
  const square = new Map()
  for (const size of SQUARE) {
    const img = await render(win, squareSvg, size)
    square.set(size, img)
    fs.writeFileSync(path.join(linuxDir, `${size}x${size}.png`), img.toPNG())
  }
  fs.writeFileSync(path.join(resources, 'icon.png'), square.get(512).toPNG())
  fs.copyFileSync(path.join(resources, 'icon.png'), path.join(root, 'src/renderer/public/icon.png'))
  writeIco(
    path.join(resources, 'icon.ico'),
    ICO.map((size) => ({
      size,
      // Vista+ reads PNG entries; the small sizes stay DIB so old shells cope too.
      data: size >= 128 ? square.get(size).toPNG() : bmpEntry(square.get(size), size)
    }))
  )

  // macOS.
  const mac = new Map()
  for (const size of MAC) mac.set(size, (await render(win, macSvg, size)).toPNG())
  fs.writeFileSync(path.join(resources, 'icon-macos.png'), mac.get(1024))
  const icns = path.join(resources, 'icon.icns')
  try {
    const set = path.join(root, 'out', 'icon.iconset')
    fs.rmSync(set, { recursive: true, force: true })
    fs.mkdirSync(set, { recursive: true })
    const names = [
      [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'], [32, 'icon_32x32.png'],
      [64, 'icon_32x32@2x.png'], [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
      [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'], [512, 'icon_512x512.png'],
      [1024, 'icon_512x512@2x.png']
    ]
    for (const [size, name] of names) fs.writeFileSync(path.join(set, name), mac.get(size))
    execFileSync('iconutil', ['-c', 'icns', set, '-o', icns])
    fs.rmSync(set, { recursive: true, force: true })
  } catch {
    writeIcns(icns, [...mac.entries()])
  }

  const listed = [
    'resources/icon.png', 'resources/icon.ico', 'resources/icon.icns', 'resources/icon-macos.png'
  ]
  for (const f of listed) console.log(`  ${f}  ${fs.statSync(path.join(root, f)).size} bytes`)
  console.log(`  resources/icons/  ${SQUARE.length} PNGs (${SQUARE.join(', ')})`)
  win.destroy()
  app.exit(0)
}).catch((err) => {
  console.error(err)
  app.exit(1)
})
