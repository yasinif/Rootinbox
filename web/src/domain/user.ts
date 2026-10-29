// Domain layer: User entity type.
// RFC-0010 §4.1: Domain has zero external dependencies.
// Mirrors backend domain/user.go structurally.

export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';

export interface User {
  id: string;
  identity_hash: string;
  public_key: string;
  status: UserStatus;
  created_at: number;
}
