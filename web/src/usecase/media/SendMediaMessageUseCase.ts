/**
 * SendMediaMessageUseCase — orchestrate media upload and send through outbox.
 * Phase 12B Task 13 (§16.1, §16.3 step 9).
 *
 * Rules:
 * - Runs UploadMediaUseCase to obtain MediaMetadata
 * - Sends MCE media payload via ChatUseCase send pipeline
 * - Returns fileId and metadata
 */

import type { MediaMetadata } from '../../domain/media/types';
import type { MediaUploadObserver } from '../../domain/ports/media';
import type { UploadMediaUseCase } from './UploadMediaUseCase';
import type { ChatUseCase } from '../chat';

export class SendMediaMessageUseCase {
  private uploadUseCase: UploadMediaUseCase;
  private chatUseCase: ChatUseCase;

  constructor(uploadUseCase: UploadMediaUseCase, chatUseCase: ChatUseCase) {
    this.uploadUseCase = uploadUseCase;
    this.chatUseCase = chatUseCase;
  }

  async execute(params: {
    conversationId: string;
    file: File | Blob;
    fileName: string;
    mimeType?: string;
    peerIdentityHash?: string;
    observer?: MediaUploadObserver;
  }): Promise<{ fileId: string; metadata: MediaMetadata }> {
    const metadata = await this.uploadUseCase.execute({
      file: params.file,
      fileName: params.fileName,
      mimeType: params.mimeType,
      conversationId: params.conversationId,
      observer: params.observer,
    });

    await this.chatUseCase.sendMedia(params.conversationId, metadata, params.peerIdentityHash, params.fileName);

    return { fileId: metadata.file_id, metadata };
  }
}
