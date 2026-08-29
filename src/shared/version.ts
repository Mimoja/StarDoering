// Semantic-version helpers for SMAPI's version format ("1.2.3", "1.2.3-beta.4", "1.2.3.4"). Pure, dependency-free.
export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  build: number
  prerelease: string | null
  raw: string
}

export function parseVersion(input: unknown): ParsedVersion | null {
  if (input == null) return null
  if (typeof input === 'object') {
    // The object form some manifests use: { MajorVersion, MinorVersion, PatchVersion, Build }
    const o = input as Record<string, unknown>
    const major = Number(o.MajorVersion ?? o.major ?? 0)
    const minor = Number(o.MinorVersion ?? o.minor ?? 0)
    const patch = Number(o.PatchVersion ?? o.patch ?? 0)
    const build = typeof o.Build === 'string' ? o.Build : o.Build != null ? String(o.Build) : null
    if ([major, minor, patch].some((n) => Number.isNaN(n))) return null
    const raw = `${major}.${minor}.${patch}${build ? '-' + build : ''}`
    return { major, minor, patch, build: 0, prerelease: build || null, raw }
  }
  const s = String(input).trim()
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    build: Number(m[4] ?? 0),
    prerelease: m[5] ?? null,
    raw: s
  }
}

function comparePrerelease(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1 // release > prerelease
  if (b === null) return -1
  const as = a.split('.')
  const bs = b.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d !== 0) return Math.sign(d)
    } else if (xn) return -1
    else if (yn) return 1
    else {
      const d = x.localeCompare(y)
      if (d !== 0) return Math.sign(d)
    }
  }
  return 0
}

// Returns <0 if a<b, 0 if equal, >0 if a>b. Unparseable versions compare as strings.
export function compareVersions(a: unknown, b: unknown): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return String(a ?? '').localeCompare(String(b ?? ''))
  for (const k of ['major', 'minor', 'patch', 'build'] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1
  }
  return comparePrerelease(pa.prerelease, pb.prerelease)
}

export function isNewerVersion(candidate: unknown, current: unknown): boolean {
  return compareVersions(candidate, current) > 0
}
