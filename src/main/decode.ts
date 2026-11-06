// Decodes a photo once for background analysis, upright and as 8-bit RGB, at the size the
// analyses need: faces work on the photo shrunk to 2048px; content analysis alone needs only
// 224x224, which decodes JPEGs much faster (sharp shrinks them while decoding).
import sharp from 'sharp'

/** Raw RGB pixels (3 bytes each, rows top to bottom). */
export interface RgbImage {
  data: Buffer
  width: number
  height: number
}

export const FACE_ANALYSIS_LONG_SIDE = 2048
export const CONTENT_IMAGE_SIZE = 224

/** `image` is anything sharp can read (a path or an encoded buffer). */
export async function decodeForAnalysis(image: string | Buffer, forFaces: boolean): Promise<RgbImage> {
  const img = sharp(image, { failOn: 'none' }).rotate()
  const sized = forFaces
    ? img.resize(FACE_ANALYSIS_LONG_SIDE, FACE_ANALYSIS_LONG_SIDE, { fit: 'inside', withoutEnlargement: true })
    : img.resize(CONTENT_IMAGE_SIZE, CONTENT_IMAGE_SIZE, { fit: 'fill', kernel: 'cubic' })
  // Greyscale, CMYK or 16-bit photos become 8-bit sRGB, so every pixel is 3 bytes.
  const { data, info } = await sized.removeAlpha().toColourspace('srgb').raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  if (info.channels !== 3) throw new Error(`Unexpected ${info.channels} channels`)
  return { data, width: info.width, height: info.height }
}
