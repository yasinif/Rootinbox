/**
 * Application context — provides use cases to presentation layer.
 * RFC-0010 §4.1: Presentation imports usecase only, never infrastructure.
 * Composition root in main.tsx wires concrete implementations.
 */

import { createContext, useContext } from 'react';
import type { AuthUseCase } from '../../usecase/auth';
import type { ChatUseCase } from '../../usecase/chat';
import type { SyncUseCase } from '../../usecase/sync';
import type { CallSessionMachine } from '../../usecase/call/CallSessionMachine';
import type { PlaceCallUseCase } from '../../usecase/call/PlaceCallUseCase';
import type { AnswerCallUseCase } from '../../usecase/call/AnswerCallUseCase';
import type { EndCallUseCase } from '../../usecase/call/EndCallUseCase';
import type { ReceiveCallSignalUseCase } from '../../usecase/call/ReceiveCallSignalUseCase';
import type { PendingCallUseCase } from '../../usecase/call/PendingCallUseCase';

import type { UploadMediaUseCase } from '../../usecase/media/UploadMediaUseCase';
import type { DownloadMediaUseCase } from '../../usecase/media/DownloadMediaUseCase';
import type { SendMediaMessageUseCase } from '../../usecase/media/SendMediaMessageUseCase';
import type { PushSubscriptionUseCase } from '../../usecase/push/PushSubscriptionUseCase';
import type { MetadataPort, UserPort, ContactPort, ConversationPort } from '../../domain';

export interface AppContextValue {
  authUC: AuthUseCase;
  chatUC: ChatUseCase;
  syncUC: SyncUseCase;
  pushUC?: PushSubscriptionUseCase;
  callMachine: CallSessionMachine;
  placeCallUC: PlaceCallUseCase;
  answerCallUC: AnswerCallUseCase;
  endCallUC: EndCallUseCase;
  receiveSignalUC?: ReceiveCallSignalUseCase;
  pendingCallUC?: PendingCallUseCase;
  uploadMediaUC?: UploadMediaUseCase;
  downloadMediaUC?: DownloadMediaUseCase;
  sendMediaUC?: SendMediaMessageUseCase;
  metadataPort: MetadataPort;
  userPort: UserPort;
  contactPort: ContactPort;
  conversationPort: ConversationPort;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('AppContext not provided. Wrap your app in AppProvider.');
  return ctx;
}

export { PasscodeProvider, usePasscodeLock } from './PasscodeContext';
export type { PasscodeContextValue } from './PasscodeContext';
