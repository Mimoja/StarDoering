import { readJson, writeJson } from './util/fs'

// Persistent JSON document with in-memory caching and atomic writes.
export class JsonStore<T extends object> {
  private data: T | null = null

  constructor(
    private readonly file: string,
    private readonly defaults: () => T
  ) {}

  async get(): Promise<T> {
    if (this.data == null) {
      const raw = await readJson<Partial<T>>(this.file, {})
      this.data = { ...this.defaults(), ...raw }
    }
    return this.data
  }

  async update(patch: Partial<T> | ((current: T) => T)): Promise<T> {
    const current = await this.get()
    this.data = typeof patch === 'function' ? patch(current) : { ...current, ...patch }
    await writeJson(this.file, this.data)
    return this.data
  }
}

// Secret encryption: Electron safeStorage in the app, a plain marker in the smoke scripts.
export interface SecretCodec {
  encrypt(plain: string): string
  decrypt(stored: string): string
}

export const plainCodec: SecretCodec = {
  encrypt: (s) => `plain:${s}`,
  decrypt: (s) => (s.startsWith('plain:') ? s.slice(6) : s)
}
