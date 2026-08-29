// The game names a save folder `<farm name>_<uniqueIDForThisGame>` with everything but ASCII letters and digits
// stripped from the farm name – and rebuilds that name on every save, so a copy must follow the same rule.
export function saveFolderPrefix(farmName: string): string {
  return farmName.replace(/[^a-zA-Z0-9]/g, '')
}
