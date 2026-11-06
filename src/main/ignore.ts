// Folders the user never wants in the library. Each rule is either:
//  - a folder NAME ("private"): any folder with that name, at any depth;
//  - a folder PATH relative to the base folder ("fuji/abstract"): that folder and everything in it.
// Matching is case-insensitive (like macOS), and only looks below the base folder, so
// e.g. macOS's own /private folder above it never counts.
import { relative, sep } from 'node:path'

export const DEFAULT_IGNORED = ['private']

/** Tidies a rule as typed or picked: trims, uses "/" separators, drops leading/trailing slashes. Empty = invalid. */
export function normaliseRule(rule: string): string {
  return rule
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.?\/+|\/+$/g, '')
}

export class IgnoreRules {
  private names: Set<string>
  private paths: string[][]

  constructor(rules: string[]) {
    const clean = rules
      .map(normaliseRule)
      .filter(Boolean)
      .map((r) => r.toLowerCase())
    this.names = new Set(clean.filter((r) => !r.includes('/')))
    this.paths = clean.filter((r) => r.includes('/')).map((r) => r.split('/'))
  }

  /** Parses the stored setting (JSON list); missing means the defaults. */
  static fromSetting(value: string | null): IgnoreRules {
    return new IgnoreRules(value === null ? DEFAULT_IGNORED : (JSON.parse(value) as string[]))
  }

  /** Whether a folder, given as its segments below the base folder, is ignored (itself or via a parent). */
  ignoresDir(segments: string[]): boolean {
    const lower = segments.map((s) => s.toLowerCase())
    if (lower.some((s) => this.names.has(s))) return true
    return this.paths.some((p) => p.length <= lower.length && p.every((seg, i) => seg === lower[i]))
  }

  /** Whether a file is inside an ignored folder below `basePath`. */
  ignoresFile(basePath: string, path: string): boolean {
    const rel = relative(basePath, path)
    if (rel.startsWith('..')) return false
    return this.ignoresDir(rel.split(sep).slice(0, -1))
  }
}
