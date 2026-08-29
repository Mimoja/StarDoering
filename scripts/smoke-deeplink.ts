// Which stardoering:// links are accepted (the shapes people paste into chats) and which are refused
// (anything that would hand git a command or a local path): npm run smoke:deeplink
import { buildProfileLink, parseDeepLink } from '../src/shared/protocol'

let failures = 0

function ok(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.log(`  ✗ ${label}${detail ? ` – ${detail}` : ''}`)
  }
}

function accepts(link: string, expect: { url: string; branch?: string; name?: string | null }): void {
  try {
    const parsed = parseDeepLink(link)
    const branch = expect.branch ?? 'main'
    const name = expect.name === undefined ? null : expect.name
    ok(link, parsed.url === expect.url && parsed.branch === branch && parsed.name === name, `got ${parsed.url} #${parsed.branch} name=${parsed.name}`)
  } catch (e) {
    ok(link, false, `threw: ${(e as Error).message}`)
  }
}

function refuses(link: string): void {
  try {
    const parsed = parseDeepLink(link)
    ok(link, false, `accepted as ${parsed.url}`)
  } catch (e) {
    ok(`${link} → ${(e as Error).message}`, true)
  }
}

console.log('accepted links')
accepts('stardoering://add-profile?url=https://github.com/you/mods.git', { url: 'https://github.com/you/mods.git' })
accepts('stardoering://add-profile?url=https%3A%2F%2Fgithub.com%2Fyou%2Fmods.git&branch=dev&name=Our%20farm', { url: 'https://github.com/you/mods.git', branch: 'dev', name: 'Our farm' })
accepts('stardoering://add-profile/https://github.com/you/mods.git', { url: 'https://github.com/you/mods.git' })
accepts('stardoering://add-profile/https://github.com/you/mods.git#dev', { url: 'https://github.com/you/mods.git', branch: 'dev' })
accepts('stardoering://add-profile/?url=https://github.com/you/mods.git', { url: 'https://github.com/you/mods.git' })
accepts('stardoering://github.com/you/mods.git', { url: 'https://github.com/you/mods.git' })
accepts('stardoering://git@github.com:you/mods.git', { url: 'git@github.com:you/mods.git' })
accepts('stardoering://add-profile?repo=ssh://git@codeberg.org/you/mods.git&ref=season-3', { url: 'ssh://git@codeberg.org/you/mods.git', branch: 'season-3' })
accepts('  <STARDOERING://ADD-PROFILE?url=https://github.com/You/Mods.git>  ', { url: 'https://github.com/You/Mods.git' })
accepts('stardoering:add-profile?url=https://github.com/you/mods.git', { url: 'https://github.com/you/mods.git' })
// A name is only a placeholder until the repository's modlist.json5 is read, so it is trimmed, not trusted.
accepts('stardoering://add-profile?url=https://github.com/you/mods.git&name=%20%20lots%20%20of%20%20space%20', { url: 'https://github.com/you/mods.git', name: 'lots of space' })

console.log('refused links')
refuses('stardoering://add-profile?url=ext::sh -c "touch /tmp/pwned"') // git transport that runs a command
refuses('stardoering://add-profile?url=file:///etc/passwd')
refuses('stardoering://add-profile?url=/Users/someone/secrets')
refuses('stardoering://add-profile?url=C:\\Users\\someone\\secrets')
refuses('stardoering://add-profile?url=--upload-pack=touch%20/tmp/pwned') // would reach git as an option
refuses('stardoering://add-profile?url=https://user:hunter2@github.com/you/mods.git') // secret would be stored in the clear
refuses('stardoering://add-profile?url=https://github.com/you/mods.git&branch=--exec=whoami')
refuses('stardoering://add-profile?url=https://github.com/you/mods.git&branch=../../evil')
refuses('stardoering://add-profile') // no repository at all
refuses('stardoering://install-mod/SomeMod') // an action we do not have
refuses('https://github.com/you/mods.git') // not our scheme

console.log('links the Copy link button produces')
function roundTrip(remote: { url: string; branch: string }): void {
  const link = buildProfileLink(remote)
  try {
    const parsed = parseDeepLink(link)
    ok(`${link}`, parsed.url === remote.url && parsed.branch === remote.branch, `parsed back as ${parsed.url} #${parsed.branch}`)
  } catch (e) {
    ok(link, false, `threw: ${(e as Error).message}`)
  }
}
roundTrip({ url: 'https://github.com/you/mods.git', branch: 'main' })
roundTrip({ url: 'git@github.com:you/mods.git', branch: 'season-3' })
roundTrip({ url: 'ssh://git@codeberg.org/you/mods.git', branch: 'main' })
// A query character in the URL has to survive the trip, so it gets encoded rather than left readable.
roundTrip({ url: 'https://git.example.com/scm/mods.git?x=1&y=2', branch: 'main' })

console.log(failures === 0 ? '\nOK – links behave' : `\nFAILED – ${failures} case(s)`)
process.exit(failures === 0 ? 0 : 1)
