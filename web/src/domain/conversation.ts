// Domain layer: Conversation entity type.
// RFC-0010 §4.1: Domain has zero external dependencies.

export interface Conversation {
  id: string;
  created_at: number;
}

export interface Participant {
  id: string;
  conversation_id: string;
  user_id: string;
  joined_at: number;
}
