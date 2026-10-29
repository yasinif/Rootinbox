/**
 * Component test for ForwardModal.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ForwardModal } from '../../src/presentation/components/message/ForwardModal';
import type { ChatMessage, ConversationItem } from '../../src/usecase/chat';

describe('ForwardModal Component Test', () => {
  const dummyMessage: ChatMessage = {
    id: 'msg-1',
    conversationId: 'conv-1',
    senderId: 'sender-1',
    plaintext: 'Important announcement for all',
    createdAt: Date.now(),
    status: 'delivered',
  };

  const conversations: ConversationItem[] = [
    {
      id: 'conv-self',
      type: 'SELF',
      createdAt: 1000,
      name: 'My Notes',
    },
    {
      id: 'conv-group',
      type: 'GROUP',
      name: 'Engineering Team',
      createdAt: 2000,
    },
    {
      id: 'conv-peer',
      type: 'DIRECT',
      peerIdentityHash: 'peer-hash-1234567890',
      createdAt: 3000,
    },
  ];

  it('renders modal with message preview and conversation targets when open', () => {
    render(
      <ForwardModal
        isOpen={true}
        onClose={vi.fn()}
        message={dummyMessage}
        conversations={conversations}
        contacts={[]}
        onForward={vi.fn()}
      />
    );

    expect(screen.getByText('Forward Message')).toBeDefined();
    expect(screen.getByText(/Important announcement for all/)).toBeDefined();
    expect(screen.getByText('📝 My Notes')).toBeDefined();
    expect(screen.getByText('👥 Engineering Team')).toBeDefined();
  });

  it('selects target conversation and calls onForward on confirm', async () => {
    const onForwardMock = vi.fn().mockResolvedValue(undefined);
    const onCloseMock = vi.fn();

    render(
      <ForwardModal
        isOpen={true}
        onClose={onCloseMock}
        message={dummyMessage}
        conversations={conversations}
        contacts={[]}
        onForward={onForwardMock}
      />
    );

    // Click on "Engineering Team" target
    const targetGroup = screen.getByText('👥 Engineering Team');
    fireEvent.click(targetGroup);

    // Click Forward button
    const forwardBtn = screen.getByRole('button', { name: 'Forward' });
    fireEvent.click(forwardBtn);

    expect(onForwardMock).toHaveBeenCalledWith('conv-group');
  });

  it('filters targets by search query', () => {
    render(
      <ForwardModal
        isOpen={true}
        onClose={vi.fn()}
        message={dummyMessage}
        conversations={conversations}
        contacts={[]}
        onForward={vi.fn()}
      />
    );

    const searchInput = screen.getByPlaceholderText('Search chats or contacts...');
    fireEvent.change(searchInput, { target: { value: 'Engineering' } });

    expect(screen.getByText('👥 Engineering Team')).toBeDefined();
    expect(screen.queryByText('📝 My Notes')).toBeNull();
  });
});
