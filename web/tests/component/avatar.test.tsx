import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { Avatar } from '../../src/presentation/components/common/Avatar';

describe('Avatar Component Test', () => {
  it('renders image when userId is provided and avatarUpdatedAt is positive', () => {
    render(<Avatar userId="usr-1" avatarUpdatedAt={1700000000} name="Alice Wonder" size="md" />);
    const imgEl = screen.getByRole('img');
    expect(imgEl).toBeDefined();
    expect(imgEl.getAttribute('src')).toBe('/api/v1/users/usr-1/avatar?t=1700000000');
  });

  it('renders initials fallback when no avatar exists or avatarUpdatedAt is 0', () => {
    render(<Avatar userId="usr-1" avatarUpdatedAt={0} name="Alice Wonder" size="md" />);
    const fallbackEl = screen.getByTestId('avatar-fallback');
    expect(fallbackEl).toBeDefined();
    expect(fallbackEl.textContent).toBe('AW');
  });

  it('falls back to initials when image loading triggers an error', () => {
    render(<Avatar userId="usr-2" avatarUpdatedAt={1700000000} name="Bob Dylan" size="md" />);
    const imgEl = screen.getByRole('img');
    fireEvent.error(imgEl);

    const fallbackEl = screen.getByTestId('avatar-fallback');
    expect(fallbackEl).toBeDefined();
    expect(fallbackEl.textContent).toBe('BD');
  });

  it('renders custom icon fallback for groups, channels, or notes', () => {
    render(<Avatar icon="👥" name="Engineering Group" size="md" />);
    const fallbackEl = screen.getByTestId('avatar-fallback');
    expect(fallbackEl.textContent).toBe('👥');
  });
});
