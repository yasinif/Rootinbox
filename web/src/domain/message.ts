// Domain layer: Message entity type.
// RFC-0010 §4.1: Domain has zero external dependencies.
// Mirrors backend domain entities structurally.

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  /** Encrypted ciphertext bytes (base64 encoded for transport). */
  ciphertext: string;
  /** Sequence number for replay-window enforcement (RFC-0003). */
  sequence: number;
  created_at: number;
  /** Local-only: decrypted plaintext, never persisted (RFC-0010 §5.3). */
  plaintext?: string;
}
