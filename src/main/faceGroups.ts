// Grouping faces into people. Embeddings are L2-normalised, so the dot product is
// the cosine similarity: ~0.8-0.95 for the same person in similar conditions,
// usually < 0.35 for different people.
//
// Errs on the side of splitting: two groups of the same person are fixed by giving
// them the same name, whereas a group mixing two people is annoying to untangle.

/** Faces at least this similar to a group's average join it. */
export const CLUSTER_THRESHOLD = 0.5
/** Groups whose averages are this similar are merged. */
export const MERGE_THRESHOLD = 0.55
/** A face is recognised as a named person at this similarity... */
export const MATCH_THRESHOLD = 0.5
/** ...if it's clearly closer to them than to anyone else. */
export const MATCH_MARGIN = 0.06

export interface FaceVector {
  id: number
  embedding: Float32Array
  /** Higher-quality faces seed groups first. */
  score: number
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function normalised(sum: Float32Array): Float32Array {
  let n = 0
  for (const x of sum) n += x * x
  n = Math.sqrt(n) || 1
  return sum.map((x) => x / n)
}

interface Cluster {
  members: number[]
  sum: Float32Array
  centroid: Float32Array
}

/** Groups similar faces. Returns face id -> group number (groups numbered by size, largest first). */
export function clusterFaces(faces: FaceVector[]): Map<number, number> {
  const clusters: Cluster[] = []
  for (const f of [...faces].sort((a, b) => b.score - a.score)) {
    let best: Cluster | null = null
    let bestSim = CLUSTER_THRESHOLD
    for (const c of clusters) {
      const sim = dot(c.centroid, f.embedding)
      if (sim >= bestSim) {
        best = c
        bestSim = sim
      }
    }
    if (best) {
      best.members.push(f.id)
      for (let i = 0; i < best.sum.length; i++) best.sum[i] += f.embedding[i]
      best.centroid = normalised(best.sum)
    } else {
      clusters.push({ members: [f.id], sum: Float32Array.from(f.embedding), centroid: f.embedding })
    }
  }

  // Merge groups that turned out to be the same person.
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (dot(clusters[i].centroid, clusters[j].centroid) >= MERGE_THRESHOLD) {
          const [a, b] = [clusters[i], clusters[j]]
          a.members.push(...b.members)
          for (let k = 0; k < a.sum.length; k++) a.sum[k] += b.sum[k]
          a.centroid = normalised(a.sum)
          clusters.splice(j, 1)
          merged = true
          break outer
        }
      }
    }
  }

  const result = new Map<number, number>()
  clusters.sort((a, b) => b.members.length - a.members.length).forEach((c, i) => c.members.forEach((id) => result.set(id, i)))
  return result
}

export interface KnownPerson {
  id: number
  /** Faces the user has confirmed as this person. */
  embeddings: Float32Array[]
}

/**
 * Recognises named people among unassigned faces. A face's similarity to a person
 * is the best of: their average face, and the mean of their 3 closest confirmed faces
 * (so people who look different with/without glasses are still matched).
 * `rejected` holds "faceId:personId" pairs the user said are wrong.
 */
export function matchPeople(faces: FaceVector[], people: KnownPerson[], rejected: Set<string>): Map<number, number> {
  const profiles = people
    .filter((p) => p.embeddings.length > 0)
    .map((p) => {
      const sum = new Float32Array(p.embeddings[0].length)
      for (const e of p.embeddings) for (let i = 0; i < sum.length; i++) sum[i] += e[i]
      return { id: p.id, centroid: normalised(sum), embeddings: p.embeddings }
    })

  const result = new Map<number, number>()
  for (const f of faces) {
    const scores = profiles
      .filter((p) => !rejected.has(`${f.id}:${p.id}`))
      .map((p) => {
        const sims = p.embeddings.map((e) => dot(e, f.embedding)).sort((a, b) => b - a)
        const top = sims.slice(0, 3)
        return { id: p.id, sim: Math.max(dot(p.centroid, f.embedding), top.reduce((s, x) => s + x, 0) / top.length) }
      })
      .sort((a, b) => b.sim - a.sim)
    const [first, second] = scores
    if (first && first.sim >= MATCH_THRESHOLD && (!second || first.sim - second.sim >= MATCH_MARGIN)) result.set(f.id, first.id)
  }
  return result
}
