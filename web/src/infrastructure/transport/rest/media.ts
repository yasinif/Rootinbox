/**
 * Media REST Client.
 * Phase 12B §11.3 + Task 8.
 *
 * Implements MediaRestClient.
 * Follows V-1, V-2, V-3, V-4 contracts from verification gate.
 */

import type { MediaRestClient } from '../../../domain/ports/media';
import { apiPost, isApiError, getAuthToken } from './client';
import { rateBudgets } from './budget';

export class MediaHttpClient implements MediaRestClient {
  /**
   * POST /api/v1/media/init
   * tokenHash is lowercase hex SHA-256 of media_token (V-1 deviation).
   */
  async initUpload(fileId: string, totalChunks: number, tokenHash: string): Promise<void> {
    await rateBudgets.restGeneral.acquire();
    try {
      await apiPost('/api/v1/media/init', {
        file_id: fileId,
        total_chunks: totalChunks,
        token_hash: tokenHash,
      });
    } catch (err) {
      if (isApiError(err) && err.status === 429) {
        rateBudgets.restGeneral.empty();
      }
      throw err;
    }
  }

  /**
   * PUT /api/v1/media/upload/{file_id}/{chunk_index}
   * 1 <= size <= 5,242,896 bytes, X-Chunk-Hash lowercase hex header (V-2).
   */
  async uploadChunk(
    fileId: string,
    chunkIndex: number,
    data: Uint8Array,
    chunkHash: string,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      throw { code: 'MED_UPLOAD_ABORTED', message: 'Upload aborted', status: 0 };
    }
    await rateBudgets.mediaChunkUpload.acquire();
    try {
      const authToken = getAuthToken();
      const url = `/api/v1/media/upload/${encodeURIComponent(fileId)}/${chunkIndex}`;

      if (typeof XMLHttpRequest !== 'undefined') {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', url);
          xhr.withCredentials = true;
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.setRequestHeader('X-Chunk-Hash', chunkHash);
          if (authToken) {
            xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
          }
          if (signal) {
            const onAbort = () => {
              xhr.abort();
              reject({ code: 'MED_UPLOAD_ABORTED', message: 'Upload aborted', status: 0 });
            };
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
          }
          if (xhr.upload && onProgress) {
            xhr.upload.onprogress = (evt) => {
              if (evt.lengthComputable) {
                onProgress(evt.loaded, evt.total);
              }
            };
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              onProgress?.(data.byteLength, data.byteLength);
              resolve();
            } else {
              if (xhr.status === 429) {
                rateBudgets.mediaChunkUpload.empty();
              }
              let body: { error?: { code?: string; message?: string } } = {};
              try {
                body = JSON.parse(xhr.responseText);
              } catch {
                // non-json
              }
              reject({
                code: body.error?.code ?? 'MED_UPLOAD_FAIL',
                message: body.error?.message ?? xhr.statusText,
                status: xhr.status,
              });
            }
          };
          xhr.onerror = () => {
            reject({
              code: 'MED_UPLOAD_FAIL',
              message: 'Network error during chunk upload',
              status: xhr.status || 0,
            });
          };
          xhr.onabort = () => {
            reject({
              code: 'MED_UPLOAD_ABORTED',
              message: 'Upload aborted',
              status: 0,
            });
          };
          xhr.send(data as unknown as XMLHttpRequestBodyInit);
        });
      } else {
        const buf = new ArrayBuffer(data.byteLength);
        new Uint8Array(buf).set(data);

        const response = await fetch(url, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Chunk-Hash': chunkHash,
            ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
          },
          body: buf,
          signal,
        });

        if (!response.ok) {
          if (response.status === 429) {
            rateBudgets.mediaChunkUpload.empty();
          }
          let body: { error?: { code?: string; message?: string } } = {};
          try {
            body = await response.json() as typeof body;
          } catch {
            // non-json
          }
          throw {
            code: body.error?.code ?? 'MED_UPLOAD_FAIL',
            message: body.error?.message ?? response.statusText,
            status: response.status,
          };
        }
        onProgress?.(data.byteLength, data.byteLength);
      }
    } catch (err) {
      if (isApiError(err) && err.status === 429) {
        rateBudgets.mediaChunkUpload.empty();
      }
      throw err;
    }
  }

  /**
   * POST /api/v1/media/finalize/{file_id}
   * file_manifest_hash in JSON body, lowercase hex (V-3).
   */
  async finalizeUpload(fileId: string, manifestHash: string): Promise<void> {
    await rateBudgets.restGeneral.acquire();
    try {
      await apiPost(`/api/v1/media/finalize/${encodeURIComponent(fileId)}`, {
        file_manifest_hash: manifestHash,
      });
    } catch (err) {
      if (isApiError(err) && err.status === 429) {
        rateBudgets.restGeneral.empty();
      }
      throw err;
    }
  }

  /**
   * GET /api/v1/media/download/{file_id}/{chunk_index}
   * Authorization: Bearer <mediaToken> (V-4).
   * Returns raw binary chunk as Uint8Array.
   */
  async downloadChunk(
    fileId: string,
    chunkIndex: number,
    mediaToken: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<Uint8Array> {
    await rateBudgets.restGeneral.acquire();
    try {
      const url = `/api/v1/media/download/${encodeURIComponent(fileId)}/${chunkIndex}`;

      if (typeof XMLHttpRequest !== 'undefined') {
        return await new Promise<Uint8Array>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url);
          xhr.responseType = 'arraybuffer';
          xhr.withCredentials = true;
          xhr.setRequestHeader('Authorization', `Bearer ${mediaToken}`);
          if (onProgress) {
            xhr.onprogress = (evt) => {
              if (evt.lengthComputable) {
                onProgress(evt.loaded, evt.total);
              }
            };
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              const u8 = new Uint8Array(xhr.response as ArrayBuffer);
              onProgress?.(u8.byteLength, u8.byteLength);
              resolve(u8);
            } else {
              if (xhr.status === 429) {
                rateBudgets.restGeneral.empty();
              }
              let body: { error?: { code?: string; message?: string } } = {};
              try {
                const text = new TextDecoder().decode(xhr.response as ArrayBuffer);
                body = JSON.parse(text);
              } catch {
                // non-json
              }
              reject({
                code: body.error?.code ?? 'MED_DOWNLOAD_FAIL',
                message: body.error?.message ?? xhr.statusText,
                status: xhr.status,
              });
            }
          };
          xhr.onerror = () => {
            reject({
              code: 'MED_DOWNLOAD_FAIL',
              message: 'Network error during chunk download',
              status: xhr.status || 0,
            });
          };
          xhr.send();
        });
      } else {
        const response = await fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          headers: {
            'Authorization': `Bearer ${mediaToken}`,
          },
        });

        if (!response.ok) {
          if (response.status === 429) {
            rateBudgets.restGeneral.empty();
          }
          let body: { error?: { code?: string; message?: string } } = {};
          try {
            body = await response.json() as typeof body;
          } catch {
            // non-json
          }
          throw {
            code: body.error?.code ?? 'MED_DOWNLOAD_FAIL',
            message: body.error?.message ?? response.statusText,
            status: response.status,
          };
        }

        const arrayBuffer = await response.arrayBuffer();
        const res = new Uint8Array(arrayBuffer);
        onProgress?.(res.byteLength, res.byteLength);
        return res;
      }
    } catch (err) {
      if (isApiError(err) && err.status === 429) {
        rateBudgets.restGeneral.empty();
      }
      throw err;
    }
  }

  /**
   * DELETE /api/v1/media/{file_id}
   * Authorization: Bearer <mediaToken> or session token.
   */
  async deleteMedia(fileId: string, mediaToken?: string): Promise<void> {
    await rateBudgets.restGeneral.acquire();
    try {
      const token = mediaToken || getAuthToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const response = await fetch(`/api/v1/media/${encodeURIComponent(fileId)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers,
      });

      if (!response.ok && response.status !== 204 && response.status !== 404) {
        if (response.status === 429) {
          rateBudgets.restGeneral.empty();
        }
        throw {
          code: 'MED_DELETE_FAIL',
          message: response.statusText,
          status: response.status,
        };
      }
    } catch (err) {
      if (isApiError(err) && err.status === 429) {
        rateBudgets.restGeneral.empty();
      }
      throw err;
    }
  }
}

export const mediaRestClient = new MediaHttpClient();
