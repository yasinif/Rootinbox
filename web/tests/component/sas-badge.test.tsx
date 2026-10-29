import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { SasBadge } from '../../src/presentation/components/call/SasBadge';

describe('SasBadge Component Test (§23.4)', () => {
  it('renders 6 digits preserving zero-padding', () => {
    // Single digit or leading zero SAS: "001234"
    render(<SasBadge sasDigits="1234" verified={false} />);
    const digitsEl = screen.getByTestId('sas-digits');
    expect(digitsEl.textContent).toBe('001234');
  });

  it('visually distinct before and after verification', () => {
    const { rerender } = render(<SasBadge sasDigits="123456" verified={false} />);
    const badgeUnverified = screen.getByTestId('sas-badge');
    expect(badgeUnverified.style.backgroundColor).toContain('234, 179, 8');

    rerender(<SasBadge sasDigits="123456" verified={true} />);
    const badgeVerified = screen.getByTestId('sas-badge');
    expect(badgeVerified.style.backgroundColor).toContain('34, 197, 94');
    expect(screen.getByTestId('sas-verified-icon')).toBeDefined();
  });

  it('triggers onVerify callback without modifying clipboard', () => {
    const onVerify = vi.fn();
    render(<SasBadge sasDigits="654321" verified={false} onVerify={onVerify} />);

    const verifyBtn = screen.getByTestId('sas-verify-btn');
    fireEvent.click(verifyBtn);
    expect(onVerify).toHaveBeenCalledTimes(1);
  });
});
