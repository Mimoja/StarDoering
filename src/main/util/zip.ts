import AdmZip from 'adm-zip'
import path from 'node:path'
import { promises as fs } from 'node:fs'

// Extract a zip into `dir` (pure JS; refuses entries that would escape the target folder).
export async function extractZip(zipPath: string, dir: string): Promise<void> {
  const root = path.resolve(dir)
  await fs.mkdir(root, { recursive: true })
  const zip = new AdmZip(zipPath)
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\\/g, '/')
    if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`Refusing to extract unsafe path "${entry.entryName}"`)
    const target = path.resolve(root, name)
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Refusing to extract outside the target folder: ${entry.entryName}`)
    if (entry.isDirectory) {
      await fs.mkdir(target, { recursive: true })
      continue
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, entry.getData())
  }
}
