// Smoke test for the modlist modules: npm run smoke:modlist
import assert from 'node:assert/strict'
import type { ModInfo } from '../src/shared/types'
import { generateModlist, normalizeGithubRepo, parseModlist, parseUpdateKey, sourcesFromUpdateKeys } from '../src/main/modlist/format'
import { buildDatasetIndex, entryState, pagesFromKeys } from '../src/main/modlist/resolve'

function mod(partial: Partial<ModInfo> & { uniqueId: string }): ModInfo {
  return {
    folder: partial.uniqueId,
    folderPath: `/Mods/${partial.uniqueId}`,
    enabled: true,
    name: partial.uniqueId.split('.').pop() ?? partial.uniqueId,
    author: 'Someone',
    version: '1.0.0',
    description: '',
    kind: 'smapi',
    dependencies: [],
    updateKeys: [],
    hasConfig: false,
    manifestErrors: [],
    sizeBytes: 0,
    fileCount: 0,
    isBundled: false,
    missingDependencies: [],
    ...partial
  }
}

// Parse
const sample = `
// group modlist
{
  name: "Our farm",
  smapi: "4.1.10",
  mods: [
    { id: "Pathoschild.Automate", name: "Automate", nexus: 1063, github: "https://github.com/Pathoschild/StardewMods", version: "2.0.0" },
    { id: "Esca.FarmTypeManager", github: "Esca-MMC/FarmTypeManager", githubAsset: "FarmTypeManager", optional: true, enabled: false, note: "spawns stuff", },
    { id: "bcmpinc.StardewHack", github: "bcmpinc/StardewHack", githubAsset: "StardewHack", version: "latest" },
    { id: "spacechase0.SpaceCore", nexus: "1348", weird: 1 },
    { id: "Bad.Nexus", nexus: -5 },
    { id: "pathoschild.automate" },
    { name: "no id" },
    "not an object",
  ],
}
`
const parsed = parseModlist(sample)
assert.ok(parsed.modlist, 'modlist parsed')
assert.equal(parsed.modlist.name, 'Our farm')
assert.equal(parsed.modlist.smapi, '4.1.10')
assert.deepEqual(parsed.modlist.mods.map((m) => m.id), ['Pathoschild.Automate', 'Esca.FarmTypeManager', 'bcmpinc.StardewHack', 'spacechase0.SpaceCore'])
assert.deepEqual(parsed.modlist.mods[0], { id: 'Pathoschild.Automate', name: 'Automate', nexus: 1063, github: 'Pathoschild/StardewMods', version: '2.0.0' })
assert.deepEqual(parsed.modlist.mods[1], { id: 'Esca.FarmTypeManager', github: 'Esca-MMC/FarmTypeManager', githubAsset: 'FarmTypeManager', optional: true, enabled: false, note: 'spawns stuff' })
assert.equal(parsed.modlist.mods[2].version, undefined, '"latest" is normalised away')
assert.equal(parsed.modlist.mods[3].nexus, 1348, 'numeric string nexus id coerced')
assert.equal(parsed.errors.length, 4, `errors: ${parsed.errors.join(' | ')}`)
assert.ok(parsed.errors.some((e) => /duplicate/.test(e)))
assert.ok(parsed.warnings.some((e) => /unknown key "weird"/.test(e)))

assert.equal(parseModlist('{ nope: 1 }').modlist, null)
assert.equal(parseModlist('not json').modlist, null)
assert.ok(/JSON5/.test(parseModlist('not json').errors[0]))
assert.equal(parseModlist('{ mods: [], smapi: "banana" }').errors.length, 1)

// Helpers
assert.equal(normalizeGithubRepo('https://github.com/Pathoschild/StardewMods.git'), 'Pathoschild/StardewMods')
assert.equal(normalizeGithubRepo('owner/repo/'), 'owner/repo')
assert.equal(normalizeGithubRepo('nope'), null)
assert.deepEqual(parseUpdateKey('Nexus:1063@BetaVersions'), { site: 'nexus', id: '1063' })
assert.deepEqual(sourcesFromUpdateKeys(['Nexus:1063', 'GitHub:Pathoschild/StardewMods', 'CurseForge:992857']), { nexus: 1063, github: 'Pathoschild/StardewMods', curseforge: 992857 })
assert.deepEqual(pagesFromKeys(['ModDrop:509760', 'Nexus:1063']).nexus, 1063)
const index = buildDatasetIndex({ 'Pathoschild.Automate': ['Nexus:1063', 'GitHub:Pathoschild/StardewMods'], 'pathoschild.AUTOMATE': ['CurseForge:1'] })
assert.equal(index.get('pathoschild.automate')?.nexus, 1063)
assert.equal(index.get('pathoschild.automate')?.curseforge, 1, 'case-insensitive keys are merged')

// State
const installed = mod({ uniqueId: 'A.B', version: '1.2.0' })
assert.equal(entryState({ id: 'A.B' }, undefined, null), 'missing')
assert.equal(entryState({ id: 'A.B' }, { ...installed, enabled: false }, null), 'disabled')
assert.equal(entryState({ id: 'A.B' }, installed, '1.3.0'), 'outdated')
assert.equal(entryState({ id: 'A.B' }, installed, '1.2.0'), 'installed')
assert.equal(entryState({ id: 'A.B', version: '1.1.0' }, installed, '9.9.9'), 'installed', 'minimum satisfied even when newer exists')
assert.equal(entryState({ id: 'A.B', version: '1.5.0' }, installed, null), 'outdated')

// Generate
const mods = [
  mod({ uniqueId: 'Pathoschild.Automate', name: 'Automate', version: '2.6.1', updateKeys: ['Nexus:1063', 'GitHub:Pathoschild/StardewMods'] }),
  mod({ uniqueId: 'Esca.FarmTypeManager', name: 'Farm Type Manager', enabled: false, updateKeys: ['Nexus:3231'] }),
  mod({ uniqueId: 'SMAPI.ConsoleCommands', name: 'Console Commands', isBundled: true }),
  mod({ uniqueId: 'New.Mod', name: 'Brand New', updateKeys: [] })
]
const fresh = generateModlist(mods, null, { generatedAt: new Date('2026-08-29T00:00:00Z') })
const freshParsed = parseModlist(fresh)
assert.ok(freshParsed.modlist, `fresh output parses: ${freshParsed.errors.join(' | ')}`)
assert.equal(freshParsed.errors.length, 0)
assert.deepEqual(freshParsed.modlist.mods.map((m) => m.id), ['Pathoschild.Automate', 'New.Mod', 'Esca.FarmTypeManager'], 'sorted by name, SMAPI built-ins left out')
assert.equal(freshParsed.modlist.mods[0].nexus, 1063)
assert.equal(freshParsed.modlist.mods[0].github, 'Pathoschild/StardewMods')
assert.equal(freshParsed.modlist.mods[2].enabled, false)
assert.ok(fresh.startsWith('// modlist.json5 – generated by StarDöring on 2026-08-29'))

const existing = `// keep me? (comments are dropped)
{
  name: "Group",
  smapi: "4.1.10",
  custom: { anything: true },
  mods: [
    { id: "Esca.FarmTypeManager", github: "Esca-MMC/FarmTypeManager", enabled: true, extra: "kept" },
    { id: "pathoschild.automate", optional: true },
    { id: "Not.Installed", nexus: 42 },
  ],
}`
const merged = generateModlist(mods, existing)
const mergedRaw = JSON.parse(JSON.stringify(parseModlist(merged)))
assert.equal(mergedRaw.errors.length, 0, merged)
assert.deepEqual(mergedRaw.modlist.mods.map((m: { id: string }) => m.id), ['Esca.FarmTypeManager', 'pathoschild.automate', 'Not.Installed', 'New.Mod'], 'order kept, new appended, built-ins left out')
assert.ok(merged.startsWith('// modlist.json5 – updated by'))
assert.ok(/custom: \{/.test(merged) && /anything: true/.test(merged), 'unknown root fields preserved')
assert.ok(/extra: "kept"/.test(merged), 'unknown entry fields preserved')
assert.ok(/name: "Group"/.test(merged) && /smapi: "4\.1\.10"/.test(merged))
assert.equal(mergedRaw.modlist.mods[0].enabled, false, 'enabled follows local state')
assert.equal(mergedRaw.modlist.mods[1].nexus, 1063, 'page id filled from manifest update keys')
assert.equal(mergedRaw.modlist.mods[1].optional, true)
assert.equal(mergedRaw.modlist.mods[1].name, 'Automate')
assert.deepEqual(mergedRaw.modlist.mods[2], { id: 'Not.Installed', nexus: 42 }, 'not-installed entries untouched')
assert.throws(() => generateModlist(mods, '{ broken'), /JSON5/)

console.log('smoke:modlist ok –', parsed.modlist.mods.length, 'entries parsed,', mergedRaw.modlist.mods.length, 'entries merged')
