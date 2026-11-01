import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecoveryKeyModal } from '../../src/presentation/components/common/RecoveryKeyModal';

describe('RecoveryKeyModal', () => {
  it('does not render when isOpen is false', () => {
    const onClose = vi.fn();
    render(<RecoveryKeyModal isOpen={false} recoveryKey="0123456789abcdef" onClose={onClose} />);
    expect(screen.queryByText(/Your Account Recovery Key/i)).toBeNull();
  });

  it('renders modal with recovery key and warning text when open', () => {
    const onClose = vi.fn();
    render(<RecoveryKeyModal isOpen={true} recoveryKey="0123456789abcdef" onClose={onClose} />);

    expect(screen.getByText(/Your Account Recovery Key/i)).toBeDefined();
    expect(screen.getByText(/If you forget your password, your message history cannot be recovered without it/i)).toBeDefined();
    expect(screen.getByText('0123456789abcdef')).toBeDefined();
    expect(screen.getByText(/I have saved my Recovery Key/i)).toBeDefined();
    expect(screen.getByText(/Skip for now/i)).toBeDefined();
  });

  it('calls onClose(false) when user confirms saving the recovery key', () => {
    const onClose = vi.fn();
    render(<RecoveryKeyModal isOpen={true} recoveryKey="0123456789abcdef" onClose={onClose} />);

    const saveBtn = screen.getByText(/I have saved my Recovery Key/i);
    fireEvent.click(saveBtn);

    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('calls onClose(true) when user chooses to skip', () => {
    const onClose = vi.fn();
    render(<RecoveryKeyModal isOpen={true} recoveryKey="0123456789abcdef" onClose={onClose} />);

    const skipBtn = screen.getByText(/Skip for now/i);
    fireEvent.click(skipBtn);

    expect(onClose).toHaveBeenCalledWith(true);
  });
});
