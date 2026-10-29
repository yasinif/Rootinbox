import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AttachmentMenu } from '../../src/presentation/components/media/AttachmentMenu';
import { SendMediaPreviewModal } from '../../src/presentation/components/media/SendMediaPreviewModal';
import { MediaAttachmentBubble } from '../../src/presentation/components/media/MediaAttachmentBubble';
import { MessageList } from '../../src/presentation/components/MessageList';
import { AppContext } from '../../src/presentation/context';

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent }: any) => (
    <div data-testid="virtuoso-container">
      {(data || []).map((item: any, index: number) => (
        <div key={item.id ?? index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));

describe('AttachmentMenu Component Tests', () => {
  it('does not render when isOpen is false', () => {
    const { container } = render(
      <AttachmentMenu isOpen={false} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders centered full-viewport overlay and 4 menu options with header and close button', () => {
    const onClose = vi.fn();
    render(<AttachmentMenu isOpen={true} onClose={onClose} />);

    const backdrop = screen.getByTestId('attachment-menu-backdrop');
    expect(backdrop).toBeDefined();
    expect(backdrop.className).toContain('attachment-menu-overlay');

    const sheet = screen.getByTestId('attachment-menu');
    expect(sheet).toBeDefined();
    expect(sheet.className).toContain('attachment-menu-card');
    expect(document.body.contains(sheet)).toBe(true);
    expect(screen.getByText('Send Attachment')).toBeDefined();

    const closeBtn = screen.getByTestId('attachment-menu-close-btn');
    expect(closeBtn).toBeDefined();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);

    const galleryOpt = screen.getByTestId('attachment-opt-gallery');
    expect(galleryOpt).toBeDefined();
    expect(galleryOpt.tagName.toLowerCase()).toBe('button');
    expect(galleryOpt.getAttribute('type')).toBe('button');
    expect(galleryOpt.className).toContain('attachment-menu-item');
    expect(galleryOpt.textContent).toContain('Gallery');
    expect(galleryOpt.textContent).toContain('Photos & Videos');

    const cameraOpt = screen.getByTestId('attachment-opt-camera');
    expect(cameraOpt).toBeDefined();
    expect(cameraOpt.tagName.toLowerCase()).toBe('button');
    expect(cameraOpt.getAttribute('type')).toBe('button');
    expect(cameraOpt.textContent).toContain('Camera');

    const fileOpt = screen.getByTestId('attachment-opt-file');
    expect(fileOpt).toBeDefined();
    expect(fileOpt.tagName.toLowerCase()).toBe('button');
    expect(fileOpt.getAttribute('type')).toBe('button');
    expect(fileOpt.textContent).toContain('File');

    const audioOpt = screen.getByTestId('attachment-opt-audio');
    expect(audioOpt).toBeDefined();
    expect(audioOpt.tagName.toLowerCase()).toBe('button');
    expect(audioOpt.getAttribute('type')).toBe('button');
    expect(audioOpt.textContent).toContain('Audio');
  });

  it('clicking backdrop calls onClose', () => {
    const onClose = vi.fn();
    render(<AttachmentMenu isOpen={true} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('attachment-menu-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking option items triggers synchronous callback and calls onClose', () => {
    const onClose = vi.fn();
    const onTriggerGallery = vi.fn();
    const onTriggerCamera = vi.fn();
    const onTriggerFile = vi.fn();
    const onTriggerAudio = vi.fn();

    render(
      <AttachmentMenu
        isOpen={true}
        onClose={onClose}
        onTriggerGallery={onTriggerGallery}
        onTriggerCamera={onTriggerCamera}
        onTriggerFile={onTriggerFile}
        onTriggerAudio={onTriggerAudio}
      />,
    );

    fireEvent.click(screen.getByTestId('attachment-opt-gallery'));
    expect(onTriggerGallery).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('attachment-opt-camera'));
    expect(onTriggerCamera).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId('attachment-opt-file'));
    expect(onTriggerFile).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByTestId('attachment-opt-audio'));
    expect(onTriggerAudio).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it('pressing Escape calls onClose', () => {
    const onClose = vi.fn();
    render(<AttachmentMenu isOpen={true} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SendMediaPreviewModal Component Tests', () => {
  const dummyImageFile = new File(['image-bytes'], 'vacation.jpg', { type: 'image/jpeg' });
  const dummyDocFile = new File(['doc-bytes'], 'report.pdf', { type: 'application/pdf' });
  const dummyZeroByteFile = new File([], 'empty.txt', { type: 'text/plain' });

  it('does not render when isOpen is false or file is null', () => {
    const { container, rerender } = render(
      <SendMediaPreviewModal isOpen={false} file={dummyImageFile} onClose={vi.fn()} onSend={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();

    rerender(
      <SendMediaPreviewModal isOpen={true} file={null} onClose={vi.fn()} onSend={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders image preview and pre-fills caption from initialCaption', () => {
    const onSend = vi.fn();
    const onClose = vi.fn();

    render(
      <SendMediaPreviewModal
        isOpen={true}
        file={dummyImageFile}
        initialCaption="Check out this view!"
        onClose={onClose}
        onSend={onSend}
      />,
    );

    const backdrop = screen.getByTestId('media-preview-modal-backdrop');
    expect(backdrop).toBeDefined();
    expect(backdrop.style.position).toBe('fixed');
    expect(backdrop.style.zIndex).toBe('1000001');

    const modal = screen.getByTestId('send-media-preview-modal');
    expect(modal).toBeDefined();
    expect(modal.style.zIndex).toBe('1000002');
    expect(document.body.contains(modal)).toBe(true);

    expect(screen.getByText(/Send Image/i)).toBeDefined();
    expect(screen.getByText('vacation.jpg')).toBeDefined();

    const captionInput = screen.getByTestId('send-media-caption-input') as HTMLInputElement;
    expect(captionInput.value).toBe('Check out this view!');

    // Submit send
    fireEvent.click(screen.getByTestId('confirm-send-media-btn'));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(dummyImageFile, 'Check out this view!', undefined);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders document file card and prevents sending 0-byte file', () => {
    const onSend = vi.fn();
    render(
      <SendMediaPreviewModal
        isOpen={true}
        file={dummyZeroByteFile}
        onClose={vi.fn()}
        onSend={onSend}
      />,
    );

    expect(screen.getByText(/Empty files \(0 bytes\) cannot be sent/i)).toBeDefined();
    const sendBtn = screen.getByTestId('confirm-send-media-btn') as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);

    fireEvent.click(sendBtn);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('pressing Escape calls onClose', () => {
    const onClose = vi.fn();
    render(
      <SendMediaPreviewModal
        isOpen={true}
        file={dummyImageFile}
        onClose={onClose}
        onSend={vi.fn()}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MediaAttachmentBubble Upload Progress & Retry Tests', () => {
  const dummyMetadata = {
    file_id: 'test-file-id-123',
    media_key: 'b64key==',
    file_iv_prefix: 'b64iv==',
    media_token: 'b64token==',
    original_size: 2097152, // 2MB
    total_chunks: 1,
    file_manifest_hash: 'b64hash==',
    mime_type: 'image/png',
    inline_thumbnail: null,
  };

  it('displays 0%-100% progress ring and byte-level KB/MB readout during upload', () => {
    render(
      <MediaAttachmentBubble
        metadata={dummyMetadata}
        fileName="photo.png"
        status="pending"
        uploadProgress={45}
        uploadProgressBytes={943718}
        uploadTotalBytes={2097152}
      />,
    );

    expect(screen.getByText(/45%/)).toBeDefined();
    expect(screen.getByText(/921.6 KB \/ 2.0 MB/)).toBeDefined();
  });

  it('renders clear error message and Retry button when upload fails', () => {
    const onRetryUpload = vi.fn();
    render(
      <MediaAttachmentBubble
        metadata={dummyMetadata}
        fileName="photo.png"
        status="failed"
        uploadError="Network connection lost"
        onRetryUpload={onRetryUpload}
      />,
    );

    expect(screen.getByText(/Network connection lost/i)).toBeDefined();
    const retryBtn = screen.getByTestId('retry-upload-btn');
    expect(retryBtn).toBeDefined();

    fireEvent.click(retryBtn);
    expect(onRetryUpload).toHaveBeenCalledTimes(1);
  });
});

describe('MessageList Attachment Menu & Mobile File Input Safeguards', () => {
  let mockChatUC: any;
  let mockAuthUC: any;
  let mockMetadataPort: any;
  let mockUploadMediaUC: any;
  let authSnapshot: any;
  let chatSnapshot: any;
  let syncSnapshot: any;
  let callSnapshot: any;

  beforeEach(() => {
    authSnapshot = {
      state: 'authenticated',
      identityHash: 'my-identity-hash',
      userId: 'my-user-id',
      username: 'myuser',
      displayName: 'My Name',
      error: null,
    };
    mockAuthUC = {
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => authSnapshot),
      logout: vi.fn(),
    };

    chatSnapshot = {
      conversations: [
        {
          id: 'conv-123',
          name: 'Alice',
          type: 'DIRECT',
          peerIdentityHash: 'peer-alice-hash',
          peerId: 'alice-id',
          createdAt: Date.now(),
        },
      ],
      activeConversationId: 'conv-123',
      messages: [],
      sending: false,
    };
    mockChatUC = {
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => chatSnapshot),
      selectConversation: vi.fn(),
      loadConversations: vi.fn(),
      sendMessage: vi.fn(),
      createConversation: vi.fn().mockResolvedValue('conv-123'),
      uploadMediaMessage: vi.fn().mockResolvedValue(undefined),
    };

    syncSnapshot = { phase: 'ready', isOnline: true };
    callSnapshot = { status: 'idle' };

    mockMetadataPort = {
      get: vi.fn(async (key: string) => {
        if (key === 'user_id') return 'my-user-id';
        if (key === 'identity_hash') return 'my-identity-hash';
        if (key === 'username') return 'myuser';
        return null;
      }),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    mockUploadMediaUC = {
      execute: vi.fn().mockResolvedValue({
        file_id: 'uploaded-123',
        original_size: 1024,
      }),
    };
  });

  const renderMessageList = () => {
    const ctx: any = {
      authUC: mockAuthUC,
      chatUC: mockChatUC,
      syncUC: { subscribe: vi.fn(() => () => {}), getSnapshot: vi.fn(() => syncSnapshot) },
      metadataPort: mockMetadataPort,
      userPort: { getMe: vi.fn().mockResolvedValue({ id: 'my-user-id' }), getProfile: vi.fn().mockResolvedValue(null), getAvatarUrl: vi.fn().mockReturnValue('') },
      contactPort: { getAll: vi.fn().mockResolvedValue([]), get: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
      conversationPort: { getConversations: vi.fn().mockResolvedValue([]) },
      uploadMediaUC: mockUploadMediaUC,
      downloadMediaUC: { execute: vi.fn() },
      callMachine: { subscribe: vi.fn(() => () => {}), getState: vi.fn(() => callSnapshot), getSnapshot: vi.fn(() => callSnapshot) },
    };

    return render(
      <AppContext.Provider value={ctx}>
        <MessageList conversationId="conv-123" />
      </AppContext.Provider>,
    );
  };

  it('renders 4 persistent offscreen inputs with .visually-hidden-file-input class', () => {
    renderMessageList();

    const galleryInput = screen.getByTestId('attach-gallery-input') as HTMLInputElement;
    const cameraInput = screen.getByTestId('attach-camera-input') as HTMLInputElement;
    const fileInput = screen.getByTestId('attach-file-input') as HTMLInputElement;
    const audioInput = screen.getByTestId('attach-audio-input') as HTMLInputElement;

    expect(galleryInput).toBeDefined();
    expect(cameraInput).toBeDefined();
    expect(fileInput).toBeDefined();
    expect(audioInput).toBeDefined();

    expect(galleryInput.className).toContain('visually-hidden-file-input');
    expect(cameraInput.className).toContain('visually-hidden-file-input');
    expect(fileInput.className).toContain('visually-hidden-file-input');
    expect(audioInput.className).toContain('visually-hidden-file-input');

    // Confirm inputs do NOT have display: none inline style
    expect(galleryInput.style.display).not.toBe('none');
    expect(cameraInput.style.display).not.toBe('none');
  });

  it('clicking 📎 button toggles AttachmentMenu open and close', async () => {
    renderMessageList();

    const attachBtn = screen.getByTestId('attach-file-btn');
    expect(attachBtn).toBeDefined();
    expect(attachBtn.getAttribute('type')).toBe('button');

    // Initially closed
    expect(screen.queryByTestId('attachment-menu')).toBeNull();

    // Click to open
    await act(async () => {
      fireEvent.click(attachBtn);
    });
    expect(screen.getByTestId('attachment-menu')).toBeDefined();

    // Click backdrop to close
    await act(async () => {
      fireEvent.click(screen.getByTestId('attachment-menu-backdrop'));
    });
    expect(screen.queryByTestId('attachment-menu')).toBeNull();
  });

  it('safeguard 1: avoids live FileList mutation trap when selecting files', async () => {
    renderMessageList();

    const galleryInput = screen.getByTestId('attach-gallery-input') as HTMLInputElement;
    const testFile = new File(['test image data'], 'sunset.jpg', { type: 'image/jpeg' });

    // Simulate file selection
    await act(async () => {
      fireEvent.change(galleryInput, {
        target: {
          files: [testFile],
        },
      });
    });

    // Preview modal should open with the selected file
    expect(screen.getByTestId('send-media-preview-modal')).toBeDefined();
    expect(screen.getByText('sunset.jpg')).toBeDefined();

    // Confirm that input value was reset so selecting the same file again triggers onChange
    expect(galleryInput.value).toBe('');
  });

  it('sending media from preview modal calls uploadMediaMessage and clears composer text if matched', async () => {
    renderMessageList();

    // Type text in composer
    const chatInput = screen.getByPlaceholderText('Type a message...') as HTMLInputElement;
    fireEvent.change(chatInput, { target: { value: 'My beach photo' } });
    expect(chatInput.value).toBe('My beach photo');

    // Select file
    const galleryInput = screen.getByTestId('attach-gallery-input') as HTMLInputElement;
    const testFile = new File(['image-content'], 'beach.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.change(galleryInput, { target: { files: [testFile] } });
    });

    // Caption should be pre-filled with composer text
    const captionInput = screen.getByTestId('send-media-caption-input') as HTMLInputElement;
    expect(captionInput.value).toBe('My beach photo');

    // Click send
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-send-media-btn'));
    });

    // uploadMediaMessage was called with correct parameters
    expect(mockChatUC.uploadMediaMessage).toHaveBeenCalledWith(
      'conv-123',
      testFile,
      'beach.png',
      mockUploadMediaUC,
      'My beach photo',
      undefined,
      'image/png',
      expect.any(String),
    );

    // Composer text was cleared since it matched caption
    expect(chatInput.value).toBe('');
  });

  it('renders download error state and retry button when download fails', async () => {
    const mockDownloadUC = {
      execute: vi.fn().mockRejectedValueOnce(new Error('Decryption integrity check failed')),
    };

    render(
      <MediaAttachmentBubble
        metadata={{
          file_id: 'err-file-123',
          media_key: 'b64key==',
          file_iv_prefix: 'b64iv==',
          media_token: 'b64token==',
          original_size: 1024,
          total_chunks: 1,
          file_manifest_hash: 'b64hash==',
          mime_type: 'application/pdf',
          inline_thumbnail: null,
        }}
        fileName="contract.pdf"
        downloadUseCase={mockDownloadUC as any}
      />,
    );

    // Click download
    const downloadBtn = screen.getByText('Download');
    await act(async () => {
      fireEvent.click(downloadBtn);
    });

    // Error state should display with Retry button
    expect(screen.getByText(/Decryption integrity check failed/i)).toBeDefined();
    const retryBtn = screen.getByTestId('retry-download-btn');
    expect(retryBtn).toBeDefined();

    // Re-mock to succeed on retry
    mockDownloadUC.execute.mockResolvedValueOnce({
      blobUrl: 'blob:http://localhost/contract-pdf',
    });

    await act(async () => {
      fireEvent.click(retryBtn);
    });

    expect(mockDownloadUC.execute).toHaveBeenCalledTimes(2);
  });

  it('clicking an option in AttachmentMenu inside MessageList triggers the persistent input click and closes menu', async () => {
    renderMessageList();

    const attachBtn = screen.getByTestId('attach-file-btn');
    await act(async () => {
      fireEvent.click(attachBtn);
    });

    const galleryOpt = screen.getByTestId('attachment-opt-gallery');
    const galleryInput = screen.getByTestId('attach-gallery-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(galleryInput, 'click');

    await act(async () => {
      fireEvent.click(galleryOpt);
    });

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('attachment-menu')).toBeNull();
  });

  it('queues multiple files and advances through preview modal sequentially', async () => {
    renderMessageList();

    const galleryInput = screen.getByTestId('attach-gallery-input') as HTMLInputElement;
    const file1 = new File(['file 1 data'], 'photo1.jpg', { type: 'image/jpeg' });
    const file2 = new File(['file 2 data'], 'photo2.png', { type: 'image/png' });

    // Select 2 files at once
    await act(async () => {
      fireEvent.change(galleryInput, {
        target: { files: [file1, file2] },
      });
    });

    // First modal shows photo1.jpg
    expect(screen.getByTestId('send-media-preview-modal')).toBeDefined();
    expect(screen.getByText('photo1.jpg')).toBeDefined();

    // Send first file
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-send-media-btn'));
    });

    // Should have sent file1
    expect(mockChatUC.uploadMediaMessage).toHaveBeenCalledWith(
      'conv-123',
      file1,
      'photo1.jpg',
      mockUploadMediaUC,
      undefined,
      undefined,
      'image/jpeg',
      expect.any(String),
    );

    // Modal advances to photo2.png!
    expect(screen.getByTestId('send-media-preview-modal')).toBeDefined();
    expect(screen.getByText('photo2.png')).toBeDefined();

    // Send second file
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-send-media-btn'));
    });

    expect(mockChatUC.uploadMediaMessage).toHaveBeenCalledWith(
      'conv-123',
      file2,
      'photo2.png',
      mockUploadMediaUC,
      undefined,
      undefined,
      'image/png',
      expect.any(String),
    );

    // Modal closes after queue is empty
    expect(screen.queryByTestId('send-media-preview-modal')).toBeNull();
  });

  it('ChatUseCase.uploadMediaMessage retains optimistic message on sendMedia failure with Retry error and updates in-place on retry', async () => {
    const { ChatUseCase } = await import('../../src/usecase/chat');
    const mockMsgPort = {
      getMessages: vi.fn().mockResolvedValue([]),
      getByConversation: vi.fn().mockResolvedValue([]),
      insertIfAbsent: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      deleteMessages: vi.fn().mockResolvedValue(undefined),
    };
    const mockMetaPort = {
      get: vi.fn(async (key: string) => {
        if (key === 'user_id') return 'user-1';
        if (key === 'identity_hash') return 'hash-1';
        return null;
      }),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const mockConvPort = {
      getConversations: vi.fn().mockResolvedValue([]),
      createConversation: vi.fn().mockResolvedValue('conv-test'),
      sendGroupMessage: vi.fn().mockRejectedValue(new Error('Network offline: WebSocket closed')),
    };

    const mockUnreadPort = {
      get: vi.fn().mockResolvedValue(0),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      getAll: vi.fn().mockResolvedValue({}),
    };

    const chatUC = new ChatUseCase(
      {} as any,
      mockMsgPort as any,
      {} as any,
      mockConvPort as any,
      null as any,
      mockMetaPort as any,
      mockUnreadPort as any,
    );
    await chatUC.selectConversation('conv-test');

    const testFile = new File(['data'], 'test.png', { type: 'image/png' });
    const mockUploadUC: any = {
      execute: vi.fn().mockResolvedValue({
        file_id: 'uploaded-fid',
        media_key: 'b64key==',
        file_iv_prefix: 'b64iv==',
        media_token: 'b64token==',
        original_size: 4,
        total_chunks: 1,
        file_manifest_hash: 'hash==',
        mime_type: 'image/png',
        inline_thumbnail: null,
      }),
    };

    // Make sendMedia fail
    vi.spyOn(chatUC, 'sendMedia').mockRejectedValueOnce(new Error('WebSocket connection dropped'));

    await chatUC.uploadMediaMessage('conv-test', testFile, 'test.png', mockUploadUC);

    // Wait microtasks for background void async to complete
    await new Promise((r) => setTimeout(r, 20));

    const state = chatUC.getSnapshot();
    expect(state.messages.length).toBe(1);
    const failedMsg = state.messages[0];
    expect(failedMsg.status).toBe('failed');
    expect(failedMsg.uploadError).toBe('WebSocket connection dropped');

    // Now retry using the failed message ID!
    vi.spyOn(chatUC, 'sendMedia').mockResolvedValueOnce(undefined);
    await chatUC.uploadMediaMessage('conv-test', testFile, 'test.png', mockUploadUC, undefined, undefined, 'image/png', failedMsg.id);

    await new Promise((r) => setTimeout(r, 20));

    // Optimistic bubble was retried and finalized (removed after sendMedia succeeded)
    const finalState = chatUC.getSnapshot();
    expect(finalState.messages.filter((m) => m.id === failedMsg.id).length).toBe(0);
  });
});

