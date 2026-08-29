import { promises as fs } from 'node:fs'
import path from 'node:path'
import { saveFolderPrefix } from '../shared/saves'
import type { SaveInfo } from '../shared/types'
import { logScope } from './activity'
import { copyDir, dirStats, exists, isDir, readText, rmrf, safeJoin } from './util/fs'

const log = logScope('game')

const SEASONS = ['Spring', 'Summer', 'Fall', 'Winter']

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

// `Tom &amp; Jerry` is a farm called "Tom & Jerry", not one called "Tom &amp; Jerry".
function unescapeXml(text: string): string {
  return text.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));/g, (all, name: string, dec: string, hex: string) => {
    if (name) return XML_ENTITIES[name]
    const code = dec ? Number(dec) : parseInt(hex, 16)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all
  })
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)
  return m ? unescapeXml(m[1]) : null
}

// Parse the small SaveGameInfo file (a serialized Farmer) that sits next to each save.
export function parseSaveGameInfo(xml: string): Omit<SaveInfo, 'folder' | 'path' | 'lastModified' | 'sizeBytes' | 'hasBackup'> {
  const season = Number(tag(xml, 'seasonForSaveGame') ?? 0)
  return {
    farmerName: tag(xml, 'name') ?? '?',
    farmName: tag(xml, 'farmName') ?? '?',
    day: Number(tag(xml, 'dayOfMonthForSaveGame') ?? 0),
    season: SEASONS[season] ?? String(season),
    year: Number(tag(xml, 'yearForSaveGame') ?? 0),
    hoursPlayed: Math.round((Number(tag(xml, 'millisecondsPlayed') ?? 0) / 3_600_000) * 10) / 10,
    money: Number(tag(xml, 'money') ?? 0),
    gameVersion: tag(xml, 'gameVersion')
  }
}

// One save folder as the list shows it; null when the folder holds no save.
async function readSave(savesDir: string, folder: string): Promise<SaveInfo | null> {
  const dir = path.join(savesDir, folder)
  const infoXml = await readText(path.join(dir, 'SaveGameInfo'))
  if (!infoXml) return null
  const mainFile = path.join(dir, folder)
  let lastModified = 0
  try {
    lastModified = (await fs.stat((await exists(mainFile)) ? mainFile : path.join(dir, 'SaveGameInfo'))).mtimeMs
  } catch {
  }
  const stats = await dirStats(dir)
  return {
    folder,
    path: dir,
    ...parseSaveGameInfo(infoXml),
    lastModified,
    sizeBytes: stats.sizeBytes,
    hasBackup: await exists(`${mainFile}_old`)
  }
}

export async function listSaves(savesDir: string): Promise<SaveInfo[]> {
  if (!(await isDir(savesDir))) return []
  const out: SaveInfo[] = []
  for (const entry of await fs.readdir(savesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const save = await readSave(savesDir, entry.name)
    if (save) out.push(save)
  }
  out.sort((a, b) => b.lastModified - a.lastModified)
  return out
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

// Replace the text of every `<tag>…</tag>` in an XML buffer; null when the tag is not in there. Buffers, not
// strings: a save file is megabytes of XML.
function replaceTag(buf: Buffer, tag: string, value: string): Buffer | null {
  const open = Buffer.from(`<${tag}>`)
  const close = Buffer.from(`</${tag}>`)
  const text = Buffer.from(value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]))
  const parts: Buffer[] = []
  let pos = 0
  for (;;) {
    const at = buf.indexOf(open, pos)
    if (at < 0) break
    const from = at + open.length
    const to = buf.indexOf(close, from)
    if (to < 0) break
    parts.push(buf.subarray(pos, from), text)
    pos = to
  }
  if (parts.length === 0) return null
  parts.push(buf.subarray(pos))
  return Buffer.concat(parts)
}

// A save id the game could have picked itself (9 digits) that no folder in `savesDir` uses yet.
async function freeSaveId(savesDir: string, prefix: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const id = String(Math.floor(100_000_000 + Math.random() * 900_000_000))
    if (!(await exists(path.join(savesDir, `${prefix}_${id}`)))) return id
  }
  throw new Error('Could not find an unused save id.')
}

// Copy a save into a folder of its own, optionally under a new farm name. Folder and file are named
// `<farm>_<uniqueIDForThisGame>` from the file's own contents, so the copy needs a fresh id or it overwrites the original.
export async function duplicateSave(savesDir: string, folder: string, opts: { farmName?: string } = {}): Promise<SaveInfo> {
  if (!folder || path.basename(folder) !== folder) throw new Error(`"${folder}" is not a save folder name.`)
  const src = safeJoin(savesDir, folder)
  if (!(await isDir(src))) throw new Error(`There is no save folder named "${folder}".`)
  if (!(await exists(path.join(src, folder)))) throw new Error(`"${folder}" contains no save file – nothing to duplicate.`)

  const farmName = opts.farmName?.trim() || null
  let prefix = /^(.*)_\d+$/.exec(folder)?.[1] ?? folder
  if (farmName) {
    prefix = saveFolderPrefix(farmName)
    if (!prefix) throw new Error('The farm name needs at least one letter or digit – the game builds the save folder name out of it.')
  }
  const id = await freeSaveId(savesDir, prefix)
  const newFolder = `${prefix}_${id}`
  const dest = path.join(savesDir, newFolder)

  await copyDir(src, dest)
  try {
    // The save file and its _old backup are both named after the folder and both carry the id.
    for (const suffix of ['', '_old']) {
      const from = path.join(dest, `${folder}${suffix}`)
      if (!(await exists(from))) continue
      let buf = replaceTag(await fs.readFile(from), 'uniqueIDForThisGame', id)
      if (!buf) throw new Error(`${folder}${suffix} has no uniqueIDForThisGame – this does not look like a save file.`)
      if (farmName) {
        // Every farmer in the save – host and farmhands – carries the farm name.
        buf = replaceTag(buf, 'farmName', farmName)
        if (!buf) throw new Error(`${folder}${suffix} has no farm name to rename.`)
      }
      await fs.writeFile(path.join(dest, `${newFolder}${suffix}`), buf)
      await fs.rm(from, { force: true })
    }
    // The load menu takes the farm name from SaveGameInfo, not out of the save itself.
    if (farmName) {
      for (const name of ['SaveGameInfo', 'SaveGameInfo_old']) {
        const p = path.join(dest, name)
        if (!(await exists(p))) continue
        const renamed = replaceTag(await fs.readFile(p), 'farmName', farmName)
        if (renamed) await fs.writeFile(p, renamed)
      }
    }
    const save = await readSave(savesDir, newFolder)
    if (!save) throw new Error(`The copy in "${newFolder}" cannot be read back.`)
    log.info(`Duplicated save "${folder}" → "${newFolder}"`, { detail: `new uniqueIDForThisGame: ${id}${farmName ? `, farm renamed to "${farmName}"` : ''}` })
    return save
  } catch (e) {
    await rmrf(dest).catch(() => undefined)
    throw e
  }
}
