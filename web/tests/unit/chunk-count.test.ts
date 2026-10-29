/**
 * Phase 12B Unit Test — Chunk Count Arithmetic.
 * §21.3 Row M-11, §23.2: Every M-11 boundary value.
 */

import { describe, it, expect } from 'vitest';
import { computeChunkCount } from '../../src/domain/media/padding';

describe('Chunk Count Arithmetic (§21.3 M-11, §23.2)', () => {
  it('original_size = 0 -> 1 chunk', () => {
    expect(computeChunkCount(0)).toBe(1);
  });

  it('original_size = 1 -> 1 chunk', () => {
    expect(computeChunkCount(1)).toBe(1);
  });

  it('original_size = 5,242,879 -> 1 chunk', () => {
    expect(computeChunkCount(5_242_879)).toBe(1);
  });

  it('original_size = 5,242,880 -> 1 chunk (NO extra chunk)', () => {
    expect(computeChunkCount(5_242_880)).toBe(1);
  });

  it('original_size = 5,242,881 -> 2 chunks', () => {
    expect(computeChunkCount(5_242_881)).toBe(2);
  });

  it('original_size = 10,485,760 -> 2 chunks (NO extra chunk)', () => {
    expect(computeChunkCount(10_485_760)).toBe(2);
  });

  it('original_size = 2,097,152,000 -> 400 chunks (maximum supported)', () => {
    expect(computeChunkCount(2_097_152_000)).toBe(400);
  });

  it('original_size = 2,097,152,001 -> REJECTED (exceeds 400)', () => {
    expect(() => computeChunkCount(2_097_152_001)).toThrow();
  });

  it('negative size is rejected', () => {
    expect(() => computeChunkCount(-1)).toThrow();
  });
});
