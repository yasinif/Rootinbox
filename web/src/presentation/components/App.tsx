import { AppRoutes } from '../routes';
import { CallOverlay } from './call/CallOverlay';
import { ErrorBoundary } from './ErrorBoundary';
import { PasscodeLockOverlay } from './passcode/PasscodeLockOverlay';

/**
 * App shell component.
 * RFC-0010 §4.2: Presentation layer — React components.
 * Components MUST access state exclusively through UseCase-layer hooks.
 * Direct instantiation of an Infrastructure class inside a component is FORBIDDEN.
 */
export function App() {
  return (
    <ErrorBoundary fallbackTitle="Application Error">
      <CallOverlay />
      <PasscodeLockOverlay>
        <AppRoutes />
      </PasscodeLockOverlay>
    </ErrorBoundary>
  );
}

