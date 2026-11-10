// The last "Save copies" options, remembered as a setting (never the destination, spec 0007 AC-11).
import type { ExportOptions } from '../shared/types.ts'

export const EXPORT_OPTIONS_KEY = 'exportOptions'
const SIDES = [0, 4000, 2000, 1600] as const

/** Reads saved or incoming options, falling back to the defaults for anything invalid. */
export function exportOptionsFrom(json: string | null | undefined): ExportOptions {
  let raw: Partial<ExportOptions> = {}
  try {
    raw = JSON.parse(json ?? '{}') ?? {}
  } catch {
    // keep defaults
  }
  const maxSide = SIDES.find((s) => s === raw.maxSide) ?? 0
  return { maxSide, dateInNames: raw.dateInNames === true }
}
