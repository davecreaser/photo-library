// Runs the content model on its own thread (spec 0002, AC-12). onnxruntime blocks the thread
// it runs on (~250 ms to load an encoder, ~60 ms per photo), and in Electron the main process's
// thread also runs the window, so the model lives here. See ContentModelWorker.
import { parentPort } from 'node:worker_threads'
import { installFsGuard } from './fsGuard.ts'
import { ContentModel, ContentModelUnavailable } from './contentModel.ts'

// This thread only reads model files: nothing at all may be written from it.
installFsGuard({ allowedRoots: () => [], protectedRoots: () => [] })

export type WorkerRequest =
  | { id: number; op: 'load'; modelsDir: string }
  | { id: number; op: 'image'; data: Uint8Array; width: number; height: number }
  | { id: number; op: 'text'; text: string }
  | { id: number; op: 'release' }

export type WorkerResponse =
  { id: number; ok: true; vector?: Float32Array } | { id: number; ok: false; message: string; reason?: ContentModelUnavailable['reason'] }

let model: ContentModel | null = null

parentPort!.on('message', async (m: WorkerRequest) => {
  try {
    let vector: Float32Array | undefined
    if (m.op === 'load') model = await ContentModel.load(m.modelsDir)
    else if (!model) throw new Error('Content model not loaded')
    else if (m.op === 'image')
      vector = await model.embedImage({ data: Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength), width: m.width, height: m.height })
    else if (m.op === 'text') vector = await model.embedText(m.text)
    else await model.releaseImageEncoder()
    const reply: WorkerResponse = { id: m.id, ok: true, vector }
    parentPort!.postMessage(reply, vector ? [vector.buffer as ArrayBuffer] : [])
  } catch (e) {
    const reply: WorkerResponse = {
      id: m.id,
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      reason: e instanceof ContentModelUnavailable ? e.reason : undefined
    }
    parentPort!.postMessage(reply)
  }
})
