// The content model on its own thread (contentWorker.ts), with the same interface as ContentModel,
// so the main process (which also runs the window) never waits for the model.
import type { Worker, WorkerOptions } from 'node:worker_threads'
import { ContentModelUnavailable, type ContentEncoder } from './contentModel.ts'
import type { RgbImage } from './decode.ts'
import type { WorkerRequest, WorkerResponse } from './contentWorker.ts'

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }
type Request = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

export class ContentModelWorker implements ContentEncoder {
  private worker: Worker
  private pending = new Map<number, Pending>()
  private nextId = 0
  private dead: Error | null = null

  private constructor(worker: Worker) {
    this.worker = worker
    worker.on('message', (r: WorkerResponse) => {
      this.pending.get(r.id)?.resolve(r)
      this.pending.delete(r.id)
      if (this.pending.size === 0) worker.unref()
    })
    const fail = (e: Error) => {
      // A crashed thread is a broken model, not a broken photo: stop rather than record photos as unreadable.
      this.dead = new ContentModelUnavailable('failed', `Content model thread stopped: ${e.message}`)
      for (const p of this.pending.values()) p.reject(this.dead)
      this.pending.clear()
    }
    worker.on('error', fail)
    worker.on('exit', (code) => fail(new Error(`exit code ${code}`)))
    // The thread keeps the process alive only while it has work (see call()).
    worker.unref()
  }

  /** Starts the thread and loads (and verifies) the model there. `createWorker` starts contentWorker.ts. */
  static async start(createWorker: (options: WorkerOptions) => Worker, modelsDir: string): Promise<ContentModelWorker> {
    const w = new ContentModelWorker(createWorker({}))
    try {
      await w.call({ op: 'load', modelsDir })
    } catch (e) {
      await w.worker.terminate()
      throw e
    }
    return w
  }

  async embedImage(image: RgbImage): Promise<Float32Array> {
    // A copy, so the transfer doesn't take a buffer that sharp may share with others.
    const data = new Uint8Array(image.data)
    return (await this.call({ op: 'image', data, width: image.width, height: image.height }, [data.buffer])).vector!
  }

  async embedText(text: string): Promise<Float32Array> {
    return (await this.call({ op: 'text', text })).vector!
  }

  async releaseImageEncoder(): Promise<void> {
    await this.call({ op: 'release' })
  }

  private call(request: Request, transfer: ArrayBuffer[] = []): Promise<Extract<WorkerResponse, { ok: true }>> {
    if (this.dead) return Promise.reject(this.dead)
    const id = this.nextId++
    this.worker.ref()
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => (r.ok ? resolve(r) : reject(r.reason ? new ContentModelUnavailable(r.reason, r.message) : new Error(r.message))),
        reject
      })
      this.worker.postMessage({ id, ...request }, transfer)
    })
  }
}
