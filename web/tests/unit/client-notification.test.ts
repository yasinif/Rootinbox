import { describe, it, expect } from 'vitest';
import { shouldNotifyInbound } from '../../src/presentation/utils/inboundNotification';

describe('S1: Client-Side Notification Filtering Invariants', () => {
  const currentUser = {
    userId: 'usr-alice-123',
    identityHash: 'hash-alice-abc',
    username: 'alice',
  };

  it('does NOT notify when document is visible', () => {
    const notify = shouldNotifyInbound({
      convId: 'conv-bob',
      senderId: 'usr-bob',
      isDocumentVisible: true,
      permissionGranted: true,
      activeConversationId: 'conv-other',
      currentUser,
    });
    expect(notify).toBe(false);
  });

  it('does NOT notify when notification permission is not granted', () => {
    const notify = shouldNotifyInbound({
      convId: 'conv-bob',
      senderId: 'usr-bob',
      isDocumentVisible: false,
      permissionGranted: false,
      activeConversationId: 'conv-other',
      currentUser,
    });
    expect(notify).toBe(false);
  });

  it('does NOT notify for own messages with senderId = self', () => {
    const notify = shouldNotifyInbound({
      convId: 'conv-bob',
      senderId: 'self',
      isDocumentVisible: false,
      permissionGranted: true,
      activeConversationId: 'conv-other',
      currentUser,
    });
    expect(notify).toBe(false);
  });

  it('does NOT notify for own messages matching current userId (other-device echo)', () => {
    const notify = shouldNotifyInbound({
      convId: 'conv-bob',
      senderId: 'usr-alice-123',
      isDocumentVisible: false,
      permissionGranted: true,
      activeConversationId: 'conv-other',
      currentUser,
    });
    expect(notify).toBe(false);
  });

  it('does NOT notify for own messages matching identityHash', () => {
    const notify = shouldNotifyInbound({
      convId: 'conv-bob',
      senderId: 'hash-alice-abc',
      isDocumentVisible: false,
      permissionGranted: true,
      activeConversationId: 'conv-other',
      currentUser,
    });
    expect(notify).toBe(false);
  });

  it('does NOT notify for own messages matching username', () => {
    const notify = shouldNotifyInbound({
      convId: 'conv-bob',
      senderId: 'alice',
      isDocumentVisible: false,
      permissionGranted: true,
      activeConversationId: 'conv-other',
      currentUser,
    });
    expect(notify).toBe(false);
  });

  it('does NOT notify for own group messages (group.msg echo from another device)', () => {
    const notify = shouldNotifyInbound({
      convId: 'group-dev-team',
      senderId: 'usr-alice-123',
      isDocumentVisible: false,
      permissionGranted: true,
      activeConversationId: 'conv-bob',
      currentUser,
    });
    expect(notify).toBe(false);
  });

  it('does NOT notify for the conversation that is currently open', () => {
    const notify = shouldNotifyInbound({
      convId: 'conv-open-chat',
      senderId: 'usr-bob',
      isDocumentVisible: false,
      permissionGranted: true,
      activeConversationId: 'conv-open-chat',
      currentUser,
    });
    expect(notify).toBe(false);
  });

  it('does NOT notify for draft conversation currently open matching senderId', () => {
    const notify = shouldNotifyInbound({
      convId: '',
      senderId: 'usr-bob',
      isDocumentVisible: false,
      permissionGranted: true,
      activeConversationId: 'draft:usr-bob',
      currentUser,
    });
    expect(notify).toBe(false);
  });

  it('DOES notify for an incoming message from another user in an inactive conversation', () => {
    const notify = shouldNotifyInbound({
      convId: 'conv-bob',
      senderId: 'usr-bob',
      isDocumentVisible: false,
      permissionGranted: true,
      activeConversationId: 'conv-charlie',
      currentUser,
    });
    expect(notify).toBe(true);
  });

  it('DOES notify for incoming group message from another member in an inactive group', () => {
    const notify = shouldNotifyInbound({
      convId: 'group-engineering',
      senderId: 'usr-charlie',
      isDocumentVisible: false,
      permissionGranted: true,
      activeConversationId: 'conv-bob',
      currentUser,
    });
    expect(notify).toBe(true);
  });

  it('DOES notify for incoming call even if no active conversation', () => {
    const notify = shouldNotifyInbound({
      convId: '',
      isCall: true,
      isDocumentVisible: false,
      permissionGranted: true,
      activeConversationId: null,
      currentUser,
    });
    expect(notify).toBe(true);
  });
});
