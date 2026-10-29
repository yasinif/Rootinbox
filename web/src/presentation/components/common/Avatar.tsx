import React, { useState, useEffect } from 'react';

export interface AvatarProps {
  userId?: string;
  avatarUpdatedAt?: number;
  name?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  className?: string;
  icon?: string; // Optional custom fallback icon (e.g. 👥 for group, 📢 for channel, 📝 for notes)
}

const SIZE_MAP = {
  xs: { size: 24, fontSize: '0.7rem' },
  sm: { size: 32, fontSize: '0.85rem' },
  md: { size: 40, fontSize: '1rem' },
  lg: { size: 56, fontSize: '1.35rem' },
  xl: { size: 80, fontSize: '1.85rem' },
  '2xl': { size: 100, fontSize: '2.25rem' },
};

function getGradient(seed: string): { bg: string; color: string } {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 45) % 360;
  return {
    bg: `linear-gradient(135deg, hsl(${h1}, 70%, 45%), hsl(${h2}, 75%, 35%))`,
    color: '#ffffff',
  };
}

function getInitials(name?: string): string {
  if (!name) return '?';
  const clean = name.trim().replace(/^@+/, '');
  if (!clean) return '?';
  const parts = clean.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

export const Avatar: React.FC<AvatarProps> = ({
  userId,
  avatarUpdatedAt,
  name,
  size = 'md',
  className = '',
  icon,
}) => {
  const [imgError, setImgError] = useState(false);
  const { size: px, fontSize } = SIZE_MAP[size] ?? SIZE_MAP.md;

  const hasAvatar = !!userId && typeof avatarUpdatedAt === 'number' && avatarUpdatedAt > 0;
  const avatarUrl = hasAvatar
    ? `/api/v1/users/${encodeURIComponent(userId)}/avatar?t=${avatarUpdatedAt}`
    : null;

  useEffect(() => {
    setImgError(false);
  }, [avatarUrl]);

  const fallbackSeed = name || userId || 'user';
  const { bg, color } = getGradient(fallbackSeed);

  const containerStyle: React.CSSProperties = {
    width: `${px}px`,
    height: `${px}px`,
    minWidth: `${px}px`,
    minHeight: `${px}px`,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    userSelect: 'none',
    boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
    flexShrink: 0,
  };

  if (avatarUrl && !imgError) {
    return (
      <div style={containerStyle} className={`avatar-container ${className}`} data-testid="avatar-image">
        <img
          src={avatarUrl}
          alt={name || 'Avatar'}
          onError={() => setImgError(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        ...containerStyle,
        background: bg,
        color,
        fontSize,
        fontWeight: 600,
        letterSpacing: '0.02em',
      }}
      className={`avatar-container avatar-fallback ${className}`}
      data-testid="avatar-fallback"
    >
      {icon ? icon : getInitials(name)}
    </div>
  );
};
