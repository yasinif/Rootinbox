/**
 * Application routes with auth guard.
 * RFC-0010 §4.2: Presentation layer routing.
 * Auth guard redirects unauthenticated users to AuthScreen.
 */

import { BrowserRouter, Route, Routes, Navigate } from 'react-router-dom';
import { useAuth } from '../hooks';
import { AuthScreen } from '../components/AuthScreen';
import { ChatScreen } from '../components/ChatScreen';
import { AdminScreen } from '../components/admin/AdminScreen';

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { state } = useAuth();
  if (state !== 'authenticated') {
    return <Navigate to="/auth" replace />;
  }
  return children;
}

export function AppRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<AuthScreen />} />
        <Route path="/admin" element={<AdminScreen />} />
        <Route
          path="/"
          element={
            <AuthGuard>
              <ChatScreen />
            </AuthGuard>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
