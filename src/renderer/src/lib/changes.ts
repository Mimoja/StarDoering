// The change lines of a commit ("Added Automate (Pathoschild.Automate)") are plain text, so their colour comes from
// the verb they start with: green = new, light blue = changed, red = removed, light green = enabled, dark red = disabled.
export type ChangeTone = 'new' | 'changed' | 'removed' | 'enabled' | 'disabled' | null

// Commits written before the colours replaced the icons still carry one in front of the verb.
const ICON = /^[★+−✓✗✎↑↓⚙]\s*/

const RULES: { re: RegExp; tone: ChangeTone }[] = [
  // Older commits marked a first upload as "Files updated: X (1.2.3, new)".
  { re: /^Files updated:.*,\s*new\)\s*$/i, tone: 'new' },
  { re: /^(Created server config|Added|Files added:)/i, tone: 'new' },
  { re: /^(Removed|Files removed:)/i, tone: 'removed' },
  { re: /^Enabled/i, tone: 'enabled' },
  { re: /^Disabled/i, tone: 'disabled' },
  { re: /^(Files updated:|Config changed:|Note for)/i, tone: 'changed' }
]

export function stripChangeIcon(line: string): string {
  return line.replace(ICON, '')
}

export function changeTone(line: string): ChangeTone {
  const text = stripChangeIcon(line).trim()
  return RULES.find((r) => r.re.test(text))?.tone ?? null
}

// Class name for one change line, e.g. "chg chg-new".
export function changeClass(line: string): string {
  const tone = changeTone(line)
  return tone ? `chg chg-${tone}` : 'chg'
}
