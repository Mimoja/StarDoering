// Prints what the detection modules find on this machine. Run: npm run smoke:detect
import path from 'node:path'
import { findGameCandidates, defaultSavesDir, stardewDataDir, smapiLogPath } from '../src/main/paths'
import { readGameVersion, readSmapiInfo, parseSmapiLog } from '../src/main/game'
import { scanMods } from '../src/main/mods'
import { listSaves } from '../src/main/saves'

async function main(): Promise<void> {
  const candidates = await findGameCandidates()
  console.log('Game candidates:', candidates)
  for (const c of candidates) {
    console.log(`  ${c.path}: version=${await readGameVersion(c.path)} smapi=${JSON.stringify(await readSmapiInfo(c.path))}`)
    const mods = await scanMods(path.join(c.path, 'Mods'))
    console.log(`  mods (${mods.length}):`, mods.map((m) => `${m.name}@${m.version}${m.enabled ? '' : ' [disabled]'}`).join(', ') || '(none)')
  }
  console.log('Data dir:', stardewDataDir())
  console.log('SMAPI log:', await parseSmapiLog(smapiLogPath(stardewDataDir())))
  const saves = await listSaves(defaultSavesDir())
  console.log(`Saves (${saves.length}) in ${defaultSavesDir()}:`)
  for (const s of saves) console.log(`  ${s.farmName} (${s.farmerName}) – ${s.season} ${s.day} Y${s.year}, ${s.hoursPlayed}h, ${s.money}g, v${s.gameVersion}, ${(s.sizeBytes / 1e6).toFixed(1)} MB`)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
