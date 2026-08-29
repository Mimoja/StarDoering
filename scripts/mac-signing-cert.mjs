// Creates a "Developer ID Application" certificate through the App Store Connect API (same .p8 key as notarization).
// Usage: node scripts/mac-signing-cert.mjs <list|csr|create|import> – see COMPILE.md; needs APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER.
import { createSign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OUT = process.env.SIGNING_DIR ?? path.join(process.cwd(), '.signing')
const KEY = path.join(OUT, 'devid.key')
const CSR = path.join(OUT, 'devid.csr')
const CER = path.join(OUT, 'devid.cer')
const P12 = path.join(OUT, 'devid.p12')
const TYPE = process.env.CERT_TYPE ?? 'DEVELOPER_ID_APPLICATION'

const die = (msg) => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] })
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

// ES256 JWT for the App Store Connect API.
function token() {
  const keyPath = process.env.APPLE_API_KEY ?? die('APPLE_API_KEY is not set (path to the AuthKey_*.p8)')
  const kid = process.env.APPLE_API_KEY_ID ?? die('APPLE_API_KEY_ID is not set')
  const iss = process.env.APPLE_API_ISSUER ?? die('APPLE_API_ISSUER is not set')
  const resolved = keyPath.startsWith('~') ? path.join(os.homedir(), keyPath.slice(1)) : keyPath
  if (!fs.existsSync(resolved)) die(`API key not found: ${resolved}`)
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iss, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' }))
  const signer = createSign('SHA256')
  signer.update(`${header}.${payload}`)
  // JWS wants the raw r||s pair, not the DER sequence openssl would hand back.
  const sig = signer.sign({ key: fs.readFileSync(resolved), dsaEncoding: 'ieee-p1363' })
  return `${header}.${payload}.${b64url(sig)}`
}

async function api(method, endpoint, body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  if (!res.ok) {
    const detail = (() => {
      try {
        return JSON.parse(text).errors?.map((e) => `${e.title}: ${e.detail}`).join('\n  ') ?? text
      } catch {
        return text
      }
    })()
    die(`${method} ${endpoint} → ${res.status}\n  ${detail}`)
  }
  return JSON.parse(text)
}

const commands = {
  async list() {
    const { data } = await api('GET', '/v1/certificates?limit=200')
    if (!data.length) return console.log('No certificates on this team yet.')
    for (const c of data) {
      const a = c.attributes
      console.log(`${a.certificateType.padEnd(28)} ${a.displayName}  (expires ${a.expirationDate?.slice(0, 10)})`)
    }
  },

  csr() {
    fs.mkdirSync(OUT, { recursive: true, mode: 0o700 })
    if (fs.existsSync(KEY)) die(`${KEY} already exists — delete it first if you really want a new key`)
    // Apple requires RSA 2048 for signing certificates.
    run('openssl', ['genrsa', '-out', KEY, '2048'])
    fs.chmodSync(KEY, 0o600)
    const cn = process.env.CERT_NAME ?? os.userInfo().username
    run('openssl', ['req', '-new', '-key', KEY, '-out', CSR, '-subj', `/CN=${cn}/C=DE`])
    console.log(`✓ ${KEY}\n✓ ${CSR}`)
    console.log('  Apple replaces the subject with "Developer ID Application: <team> (<TEAMID>)".')
  },

  async create() {
    if (!fs.existsSync(CSR)) die(`${CSR} missing — run "csr" first`)
    const { data } = await api('POST', '/v1/certificates', {
      data: { type: 'certificates', attributes: { certificateType: TYPE, csrContent: fs.readFileSync(CSR, 'utf8') } }
    })
    fs.writeFileSync(CER, Buffer.from(data.attributes.certificateContent, 'base64'))
    console.log(`✓ ${CER}  (${data.attributes.displayName})`)
  },

  import() {
    if (!fs.existsSync(CER)) die(`${CER} missing — run "create" first`)
    const pem = path.join(OUT, 'devid.pem')
    run('openssl', ['x509', '-inform', 'DER', '-in', CER, '-out', pem])
    // A .p12 is what both the keychain and CI (electron-builder's CSC_LINK) want.
    const pass = process.env.P12_PASSWORD ?? 'stardoring'
    run('openssl', ['pkcs12', '-export', '-inkey', KEY, '-in', pem, '-out', P12, '-name', 'Developer ID Application', '-passout', `pass:${pass}`])
    fs.chmodSync(P12, 0o600)
    const keychain = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db')
    run('security', ['import', P12, '-k', keychain, '-P', pass, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security'])
    console.log(`✓ ${P12} (password: ${pass})\n✓ imported into ${keychain}`)
    console.log('\nIdentities now available:')
    console.log(run('security', ['find-identity', '-v', '-p', 'codesigning']))
    console.log(`For CI: CSC_LINK=$(base64 -i ${P12}) and CSC_KEY_PASSWORD=${pass}`)
  }
}

const cmd = process.argv[2]
if (!commands[cmd]) die(`usage: node scripts/mac-signing-cert.mjs <${Object.keys(commands).join('|')}>`)
await commands[cmd]()
