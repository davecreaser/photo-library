// SigLIP's text tokenizer (a SentencePiece Unigram model), written here so the app doesn't
// depend on Transformers.js at runtime (ADR 0008). It reproduces Transformers.js 4.3.1 exactly
// for this model's tokenizer.json (test/content-model.test.ts compares token ids with it):
//   normalise (NFKC, control characters dropped, odd spaces made plain, runs of spaces collapsed)
//   → split out the special tokens "</s>" and "<unk>" → "▁" for spaces and in front of each piece
//   → best segmentation by Viterbi over the vocabulary's log-probabilities (unknown characters
//   become <unk>, consecutive ones fused) → append </s> → truncate and pad (with </s>) to 64.

export const MAX_TOKENS = 64

interface AddedToken {
  id: number
  content: string
  lstrip: boolean
  rstrip: boolean
}

/** The parts of a Hugging Face tokenizer.json this tokenizer reads. */
export interface TokenizerJson {
  added_tokens: AddedToken[]
  model: { type: string; unk_id: number; vocab: [string, number][] }
  post_processor: { type: string; special_tokens: Record<string, { ids: number[] }> }
}

interface TrieNode {
  children: Map<string, TrieNode>
  /** Vocabulary id when a piece ends here. */
  id: number
}

const SPACE = '\u2581' // "▁", SentencePiece's visible space

export class SiglipTokenizer {
  private root: TrieNode = { children: new Map(), id: -1 }
  private scores: Float64Array
  private ids = new Map<string, number>()
  private unkId: number
  private unkScore: number
  private eosId: number
  private added = new Map<string, AddedToken>()

  constructor(json: TokenizerJson) {
    const { vocab, unk_id: unkId } = json.model
    if (json.model.type !== 'Unigram') throw new Error(`Unsupported tokenizer model ${json.model.type}`)
    this.scores = new Float64Array(vocab.length)
    let min = Infinity
    vocab.forEach(([piece, score], id) => {
      this.scores[id] = score
      if (score < min) min = score
      this.ids.set(piece, id)
      let node = this.root
      for (const ch of piece) {
        let next = node.children.get(ch)
        if (!next) node.children.set(ch, (next = { children: new Map(), id: -1 }))
        node = next
      }
      node.id = id
    })
    this.unkId = unkId
    // As in SentencePiece: an unknown character costs 10 more than the least likely piece.
    this.unkScore = min - 10
    this.scores[unkId] = this.unkScore
    for (const t of json.added_tokens) {
      this.added.set(t.content, t)
      this.ids.set(t.content, t.id)
    }
    this.eosId = json.post_processor.special_tokens['</s>'].ids[0]
  }

  /** Token ids for `text`, always MAX_TOKENS long. */
  encode(text: string): number[] {
    const ids: number[] = []
    const normalised = normalise(text)
    if (normalised.length > 0) {
      const sections = this.splitAdded(normalised)
      for (const section of sections) {
        if (section.length === 0) continue
        const special = this.added.get(section)
        if (special) {
          ids.push(special.id)
          continue
        }
        const pieces = fuseUnknown(this.segment(metaspace(section)), (p) => this.idOf(p) === this.unkId)
        for (const p of pieces) ids.push(this.idOf(p))
      }
    }
    ids.push(this.eosId)
    // Truncation keeps the start, even if that cuts off </s> (as the reference does).
    const out = ids.slice(0, MAX_TOKENS)
    while (out.length < MAX_TOKENS) out.push(this.eosId)
    return out
  }

  private idOf(piece: string): number {
    return this.ids.get(piece) ?? this.unkId
  }

  /** Splits around special tokens, trimming spaces next to them where the token asks for it. */
  private splitAdded(text: string): string[] {
    const parts: string[] = []
    let start = 0
    let i = 0
    while (i < text.length) {
      let match: string | null = null
      for (const content of this.added.keys()) {
        if (text.startsWith(content, i) && (!match || content.length > match.length)) match = content
      }
      if (match) {
        if (i > start) parts.push(text.slice(start, i))
        parts.push(match)
        i += match.length
        start = i
      } else {
        i++
      }
    }
    if (start < text.length) parts.push(text.slice(start))
    parts.forEach((part, k) => {
      const token = this.added.get(part)
      if (!token) return
      if (token.lstrip && k > 0) parts[k - 1] = parts[k - 1].trimEnd()
      if (token.rstrip && k < parts.length - 1) parts[k + 1] = parts[k + 1].trimStart()
    })
    return parts
  }

  /** Most likely segmentation of `text` into vocabulary pieces (Viterbi), as piece strings. */
  private segment(text: string): string[] {
    const chars = Array.from(text)
    const n = chars.length
    // best[i]: best total score of a segmentation of chars[0..i), and the piece ending there.
    const best = new Float64Array(n + 1).fill(-Infinity)
    const from = new Int32Array(n + 1).fill(-1)
    best[0] = 0
    // Pieces are tried in the reference's order (by start, then by length), keeping the first
    // of equal scores, so ties resolve identically.
    const ends: { start: number; score: number }[][] = Array.from({ length: n + 1 }, () => [])
    for (let start = 0; start < n; start++) {
      let node: TrieNode | undefined = this.root
      let single = false
      for (let end = start; end < n; end++) {
        node = node.children.get(chars[end])
        if (!node) break
        if (node.id >= 0) {
          ends[end + 1].push({ start, score: this.scores[node.id] })
          if (end === start) single = true
        }
      }
      if (!single) ends[start + 1].push({ start, score: this.unkScore })
    }
    for (let end = 1; end <= n; end++) {
      for (const e of ends[end]) {
        const total = best[e.start] + e.score
        if (from[end] === -1 || total > best[end]) {
          best[end] = total
          from[end] = e.start
        }
      }
    }
    const pieces: string[] = []
    for (let end = n; end > 0; end = from[end]) pieces.push(chars.slice(from[end], end).join(''))
    return pieces.reverse()
  }
}

/** The Precompiled normaliser as the reference implements it, then runs of spaces collapsed. */
export function normalise(text: string): string {
  text = text.replace(/[\u0001-\u0008\u000B\u000E-\u001F\u007F\u008F\u009F]/g, '')
  text = text.replace(/[\u0009\u000A\u000C\u000D\u00A0\u1680\u2000-\u200F\u2028\u2029\u202F\u205F\u2581\u3000\uFEFF\uFFFD]/g, ' ')
  text = text.includes('\uFF5E')
    ? text
        .split('\uFF5E')
        .map((part) => part.normalize('NFKC'))
        .join('\uFF5E')
    : text.normalize('NFKC')
  return text.replace(/ {2,}/g, ' ')
}

/** Spaces become "▁", and every section starts with one. */
function metaspace(text: string): string {
  const replaced = text.replaceAll(' ', SPACE)
  return replaced.startsWith(SPACE) ? replaced : SPACE + replaced
}

/** Joins runs of unknown pieces into one (each run becomes a single <unk>). */
function fuseUnknown(pieces: string[], isUnknown: (piece: string) => boolean): string[] {
  const fused: string[] = []
  let i = 0
  while (i < pieces.length) {
    fused.push(pieces[i])
    if (!isUnknown(pieces[i])) {
      i++
      continue
    }
    while (++i < pieces.length && isUnknown(pieces[i])) {
      if (!isUnknown(fused[fused.length - 1])) fused[fused.length - 1] += pieces[i]
    }
  }
  return fused
}
