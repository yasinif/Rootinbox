/// <reference types="vite/client" />

declare const __BUILD_TIMESTAMP__: string;

interface ImportMetaEnv {
  readonly VITE_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
