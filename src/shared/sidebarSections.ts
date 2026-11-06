/** Which collapsible sidebar sections are open (spec 0004). Stored as JSON in the `sidebarSections` setting. */
export interface SidebarSections {
  people: boolean
  albums: boolean
  tags: boolean
}

export const DEFAULT_SIDEBAR_SECTIONS: SidebarSections = { people: false, albums: true, tags: true }

/** Reads the saved value; anything missing or unreadable falls back to the defaults, per section. */
export function parseSidebarSections(raw: string | null | undefined): SidebarSections {
  const out = { ...DEFAULT_SIDEBAR_SECTIONS }
  if (!raw) return out
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === 'object') {
      for (const k of Object.keys(out) as (keyof SidebarSections)[]) {
        const x = (v as Record<string, unknown>)[k]
        if (typeof x === 'boolean') out[k] = x
      }
    }
  } catch {
    // unreadable: defaults
  }
  return out
}
