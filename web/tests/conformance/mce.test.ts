/**
 * Phase 12B Conformance Tests — MCE Content Envelope.
 */

import { describe, it, expect } from 'vitest';
import vectors from '../../src/__vectors__/crypto-vectors-v2.json';
import { mceEncodeText, mceDecode, mceDisplayText } from '../../src/domain/protocol/content-envelope';
import { hexEncode } from '../../src/workers/crypto/encoding';

const v = vectors.vectors;

describe('E-01: mce_text', () => {
  const vec = v.mce_text;

  it('encodes simple text matching vector', () => {
    const envelope = mceEncodeText('Hello, World!');
    expect(envelope).toBe(vec.simple_json);
    const encoded = new TextEncoder().encode(envelope);
    expect(hexEncode(encoded)).toBe(vec.simple_hex);
  });

  it('encodes emoji and escapes matching vector', () => {
    const envelope = mceEncodeText('Hello 👋\r\nWorld "quoted"');
    expect(envelope).toBe(vec.emoji_json);
    const encoded = new TextEncoder().encode(envelope);
    expect(hexEncode(encoded)).toBe(vec.emoji_hex);
  });
});

describe('E-02: mceDecode', () => {
  it('decodes v1 text envelope', () => {
    const result = mceDecode('{"v":1,"t":"text","b":"Hello, World!"}');
    expect(result).not.toBeNull();
    expect(result!.t).toBe('text');
    if (result!.t === 'text') {
      expect(result!.b).toBe('Hello, World!');
    }
  });

  it('rejects v2 envelope', () => {
    expect(mceDecode('{"v":2,"t":"text","b":"hi"}')).toBeNull();
  });

  it('rejects invalid JSON', () => {
    expect(mceDecode('not json')).toBeNull();
  });

  it('rejects non-object', () => {
    expect(mceDecode('"just a string"')).toBeNull();
  });
});

describe('E-03: mceDisplayText', () => {
  it('extracts text from MCE text envelope', () => {
    expect(mceDisplayText('{"v":1,"t":"text","b":"Hello"}')).toBe('Hello');
  });

  it('returns [Media] for MCE media envelope', () => {
    expect(mceDisplayText('{"v":1,"t":"media","m":{}}')).toBe('[Media]');
  });

  it('returns legacy string as-is', () => {
    expect(mceDisplayText('Legacy plain text message')).toBe('Legacy plain text message');
  });
});
