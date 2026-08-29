// Shown by main and renderer alike when no git binary answers.
export function gitInstallHint(platform: string): string {
  switch (platform) {
    case 'win32':
      return 'Git is not installed. Install "Git for Windows" from https://git-scm.com/download/win and restart StarDöring.'
    case 'darwin':
      return 'Git is not installed. Run "xcode-select --install" in Terminal (or install it from https://git-scm.com) and restart StarDöring.'
    default:
      return 'Git is not installed. Install it with your package manager (e.g. "sudo apt install git" / "sudo pacman -S git") and restart StarDöring.'
  }
}
