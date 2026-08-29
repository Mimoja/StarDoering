import path from 'node:path'
import type { ModlistStatus } from '../../shared/types'
import type { GameService } from '../game'
import { scanMods } from '../mods'
import { generateModlist, parseModlist, type GenerateOptions } from './format'
import { resolveModlist, type CatalogLookup } from './resolve'

export interface ModlistServiceDeps {
  userData: string
  game: GameService
  // Where "latest version" comes from; a getter because the catalog is built after this service.
  catalog?: () => CatalogLookup
}

// Text in, status out: modlist.json5 lives in the profile's repository, nothing here persists it.
export class ModlistService {
  private readonly datasetCacheFile: string

  constructor(private readonly deps: ModlistServiceDeps) {
    this.datasetCacheFile = path.join(deps.userData, 'modlist-dataset-index.json')
  }

  // Compare the text with the installed mods (+ latest versions from the catalog). Never throws for network trouble.
  async status(text: string): Promise<ModlistStatus> {
    const parsed = parseModlist(text)
    const info = await this.deps.game.getInfo()
    const installed = info.modsDir ? await scanMods(info.modsDir) : []
    const warnings = [...parsed.warnings]
    if (!info.modsDir) warnings.push('Stardew Valley was not found – nothing counts as installed. Set the game folder in Settings.')
    const smapiVersion = info.smapi.version
    const status: ModlistStatus = {
      modlist: parsed.modlist,
      errors: parsed.errors,
      warnings,
      entries: [],
      extra: [],
      smapi: {
        required: parsed.modlist?.smapi ?? 'latest',
        installed: smapiVersion,
        latest: null,
        ok: info.smapi.installed,
        message: info.smapi.installed ? `SMAPI ${smapiVersion ?? ''} is installed.`.replace('  ', ' ') : 'SMAPI is not installed.'
      }
    }
    if (!parsed.modlist) return status

    const resolved = await resolveModlist(parsed.modlist, installed, { smapiVersion, datasetCacheFile: this.datasetCacheFile, catalog: this.deps.catalog?.() })
    status.entries = resolved.entries
    status.extra = resolved.extra
    status.smapi = resolved.smapi
    status.warnings.push(...resolved.warnings)
    return status
  }

  // modlist.json5 text from the installed mods, merged into `existingText` when given. Throws when that is not JSON5.
  async generate(existingText?: string | null, opts: GenerateOptions & { onlyListed?: boolean } = {}): Promise<string> {
    const info = await this.deps.game.getInfo()
    let mods = info.modsDir ? await scanMods(info.modsDir) : []
    // With an existing config only its listed mods are refreshed; installed-but-unlisted ones are added explicitly (addInstalled).
    if (opts.onlyListed && existingText && existingText.trim()) {
      const listed = new Set((parseModlist(existingText).modlist?.mods ?? []).map((e) => e.id.toLowerCase()))
      mods = mods.filter((m) => m.uniqueId && listed.has(m.uniqueId.toLowerCase()))
    }
    const { onlyListed: _ignored, ...rest } = opts
    return generateModlist(mods, existingText ?? null, rest)
  }
}
