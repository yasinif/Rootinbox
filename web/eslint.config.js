import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

/**
 * ESLint configuration with boundary enforcement.
 * RFC-0010 §4.1: Dependency boundaries MUST be enforced via eslint-plugin-boundaries.
 * RFC-0010 §14 F3: A component directly importing Infrastructure fails CI.
 */
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      boundaries,
    },
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
      },
      'boundaries/elements': [
        { type: 'domain', pattern: 'domain/**' },
        { type: 'usecase', pattern: 'usecase/**' },
        { type: 'infrastructure', pattern: 'infrastructure/**' },
        { type: 'presentation', pattern: 'presentation/**' },
        { type: 'workers', pattern: 'workers/**' },
      ],
    },
    rules: {
      // RFC-0010 §4.1: Enforce Clean Architecture dependency graph.
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            // domain → no imports from any other layer (zero deps)
            {
              from: { element: { type: 'domain' } },
              allow: {
                to: { element: { type: 'domain' } },
              },
            },
            // usecase → may import domain only (no React, no infra)
            {
              from: { element: { type: 'usecase' } },
              allow: {
                to: { element: { types: { anyOf: ['domain', 'usecase'] } } },
              },
            },
            // infrastructure → may import domain only
            {
              from: { element: { type: 'infrastructure' } },
              allow: {
                to: { element: { types: { anyOf: ['domain', 'infrastructure'] } } },
              },
            },
            // presentation → may import domain, usecase only (NOT infrastructure — F3)
            {
              from: { element: { type: 'presentation' } },
              allow: {
                to: { element: { types: { anyOf: ['domain', 'usecase', 'presentation'] } } },
              },
            },
            // workers → may import domain, infrastructure
            {
              from: { element: { type: 'workers' } },
              allow: {
                to: { element: { types: { anyOf: ['domain', 'infrastructure', 'workers'] } } },
              },
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.config.*'],
  },
  // Phase 12B §2.6: RTCPeerConnection only in infrastructure/transport/webrtc/
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: [
      'src/infrastructure/transport/webrtc/**',
      'src/__mocks__/webrtc.ts',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'RTCPeerConnection',
          message: 'RTCPeerConnection may only be used in infrastructure/transport/webrtc/. See Phase 12B §2.6.',
        },
      ],
    },
  },
  // Phase 12B §2.6: Notification API only in workers/sw.ts
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/workers/sw.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'Notification',
          message: 'Notification API may only be used in workers/sw.ts. See Phase 12B §2.6.',
        },
      ],
    },
  },
);

