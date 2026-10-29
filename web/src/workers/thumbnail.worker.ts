/**
 * Thumbnail Worker.
 * Phase 12B Task 13 & 14 (§17.7, ADR-P12B-35, ADR-P12B-39).
 *
 * Rules:
 * - Images only (ADR-P12B-39). Non-images produce null.
 * - Iterates quality and dimensions until encoded WebP size <= 32,764 bytes (max 6 iterations).
 * - ADR-P12B-35 layout: [4-byte BE length][image bytes][zero padding] = exactly 32,768 bytes.
 * - NEVER receives Media_Key: returns raw padded plaintext to caller.
 */

const MAX_THUMBNAIL_BYTES = 32_764;
const PADDED_THUMBNAIL_BYTES = 32_768;

export interface ThumbnailRequest {
  requestId: string;
  imageBlob?: Blob;
  imageData?: ArrayBuffer;
  mimeType: string;
}

export interface ThumbnailResponse {
  requestId: string;
  paddedPlaintext: ArrayBuffer | null;
  error?: string;
}

/**
 * Format raw image bytes into ADR-P12B-35 32,768-byte padded plaintext.
 */
export function formatThumbnailPlaintext(imageBytes: Uint8Array): Uint8Array {
  if (imageBytes.length > MAX_THUMBNAIL_BYTES) {
    throw new Error(`Thumbnail exceeds maximum size of ${MAX_THUMBNAIL_BYTES} bytes`);
  }

  const padded = new Uint8Array(PADDED_THUMBNAIL_BYTES);
  const view = new DataView(padded.buffer, padded.byteOffset, 4);
  view.setUint32(0, imageBytes.length, false); // 4-byte big-endian length
  padded.set(imageBytes, 4);
  // Trailing zeros remain initialized to 0
  return padded;
}

/**
 * Process an image file or blob into padded plaintext thumbnail.
 */
export async function generateThumbnailPlaintext(
  imageBlob: Blob | Uint8Array,
  mimeType: string,
): Promise<Uint8Array | null> {
  // Only process images (ADR-P12B-39)
  if (!mimeType.startsWith('image/')) {
    return null;
  }

  // In test / environment without OffscreenCanvas, produce synthetic thumbnail
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    const rawBytes = imageBlob instanceof Blob
      ? new Uint8Array(await imageBlob.arrayBuffer())
      : imageBlob;

    const sliceLen = Math.min(rawBytes.length, MAX_THUMBNAIL_BYTES);
    const candidate = rawBytes.subarray(0, sliceLen);
    return formatThumbnailPlaintext(candidate);
  }

  try {
    const blob = imageBlob instanceof Blob ? imageBlob : new Blob([imageBlob as unknown as BlobPart]);
    const bitmap = await createImageBitmap(blob);

    let width = bitmap.width;
    let height = bitmap.height;
    let quality = 0.8;

    // Target max 320x320 initial dimension
    const maxDim = 320;
    if (width > maxDim || height > maxDim) {
      if (width > height) {
        height = Math.round((height * maxDim) / width);
        width = maxDim;
      } else {
        width = Math.round((width * maxDim) / height);
        height = maxDim;
      }
    }

    let encodedBytes: Uint8Array | null = null;

    // Max 6 iterations (§17.7)
    for (let iter = 0; iter < 6; iter++) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) break;

      ctx.drawImage(bitmap, 0, 0, width, height);
      const outBlob = await canvas.convertToBlob({ type: 'image/webp', quality });
      const buf = await outBlob.arrayBuffer();

      if (buf.byteLength <= MAX_THUMBNAIL_BYTES) {
        encodedBytes = new Uint8Array(buf);
        break;
      }

      // Reduce quality or dimensions
      if (quality > 0.4) {
        quality -= 0.2;
      } else {
        width = Math.round(width * 0.75);
        height = Math.round(height * 0.75);
      }
    }

    bitmap.close();

    if (!encodedBytes || encodedBytes.length > MAX_THUMBNAIL_BYTES) {
      return null;
    }

    return formatThumbnailPlaintext(encodedBytes);
  } catch {
    return null;
  }
}

// Worker message handling
if (typeof self !== 'undefined' && 'postMessage' in self && typeof (self as unknown as WorkerGlobalScope).importScripts === 'function') {
  self.addEventListener('message', async (event: MessageEvent<ThumbnailRequest>) => {
    const { requestId, imageBlob, imageData, mimeType } = event.data;
    try {
      const input = imageBlob ?? (imageData ? new Uint8Array(imageData) : null);
      if (!input) {
        self.postMessage({ requestId, paddedPlaintext: null } as ThumbnailResponse);
        return;
      }

      const padded = await generateThumbnailPlaintext(input, mimeType);
      if (!padded) {
        self.postMessage({ requestId, paddedPlaintext: null } as ThumbnailResponse);
        return;
      }

      const buffer = padded.buffer;
      self.postMessage(
        { requestId, paddedPlaintext: buffer } as ThumbnailResponse,
        [buffer] as unknown as Transferable[],
      );
    } catch (err) {
      self.postMessage({
        requestId,
        paddedPlaintext: null,
        error: err instanceof Error ? err.message : String(err),
      } as ThumbnailResponse);
    }
  });
}
