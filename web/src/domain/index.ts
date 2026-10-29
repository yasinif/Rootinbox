// Domain layer barrel export.
// RFC-0010 §4.1: Domain has zero external dependencies.

export type { User, UserStatus } from './user';
export type { Message } from './message';
export type { Conversation, Participant } from './conversation';
export type {
  AuthPort, CryptoPort, MessagePort, OutboxPort,
  ConversationPort, DirectoryPort, MetadataPort,
  RegisterParams, LoginParams, AuthResult, ChallengeResult,
  EncryptParams, EncryptResult, DecryptParams, DecryptResult,
  StoredMessageDTO, OutboxEntryDTO, ConversationDTO, PeerInfo,
  UserPort, UserSearchResult, UserProfile, ContactPort, ContactDTO,
  ConversationMemberDTO, GroupMessageDTO, CreateGroupParams,
  UnreadPort, VaultArchivePort, VaultMeta, HistoryItemDTO,
  SessionDTO, DeliveryAckDTO,
} from './ports';
export { encodeRoutingId, hexToBase64StdPadded, base64StdToHex, generateUUID } from './encoding';
export { toMillis } from './timestamp';

// Phase 12B domain sub-modules.
export * from './call';
export * from './media';
export * from './protocol';
export * from './errors';
export * from './passcode';
export type {
  CallSignalTransport, CallRepository, CallStateProbe, CallRestClient,
  CallMediaSession, CallMediaSessionFactory, CallMediaSessionCallbacks, CallCryptoPort,
  MediaRestClient, MediaRepository, MediaChunkCache, MediaUploadObserver, ThumbnailPort,
  PushRestClient, PushSubscriptionPort, SWLogEvent,
} from './ports/index';

/**
 * CryptoWorkerRequest / CryptoWorkerResponse types for the
 * message-passing protocol between main thread and Crypto Worker.
 * RFC-0010 §5.2: All Worker calls correlated via request_id (UUIDv4).
 */
export interface CryptoWorkerRequest {
  request_id: string;
  action: string;
  payload?: unknown;
}

export interface CryptoWorkerResponse {
  request_id: string;
  result?: unknown;
  error?: string;
}
