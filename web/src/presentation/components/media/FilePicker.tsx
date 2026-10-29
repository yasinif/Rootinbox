/**
 * FilePicker — Accessible file selection for media attachments.
 * Phase 12B §18.1.
 */

import React, { useRef } from 'react';
import { MAX_FILE_SIZE } from '../../../domain/media/constants';

interface FilePickerProps {
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}

export const FilePicker: React.FC<FilePickerProps> = ({ onFileSelected, disabled = false }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    if (fileInputRef.current && !disabled) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      alert('File size exceeds the 2 GB limit.');
      return;
    }

    onFileSelected(file);
  };

  return (
    <div className="file-picker-container" style={{ display: 'inline-flex', alignItems: 'center' }}>
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleChange}
        disabled={disabled}
        aria-label="Attach file"
      />
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className="attach-btn"
        title="Attach file"
        aria-label="Attach file"
      >
        📎
      </button>
    </div>
  );
};
