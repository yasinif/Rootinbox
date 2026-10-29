/**
 * DevicePicker component.
 * Phase 12B Task 12 (§15.1).
 *
 * Allows switching microphone and speaker devices.
 */

import React from 'react';
import { useMediaDevices } from '../../hooks/useMediaDevices';

export interface DevicePickerProps {
  onClose?: () => void;
}

export const DevicePicker: React.FC<DevicePickerProps> = ({ onClose }) => {
  const {
    audioInputs,
    audioOutputs,
    selectedAudioInput,
    selectedAudioOutput,
    setSelectedAudioInput,
    setSelectedAudioOutput,
  } = useMediaDevices();

  return (
    <div
      data-testid="device-picker-modal"
      className="device-picker"
    >
      <div className="device-picker-header">
        <h4 style={{ margin: 0, fontSize: 'var(--font-sm)', fontWeight: 600 }}>Audio Settings</h4>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: 'var(--font-sm)' }}
            aria-label="Close"
          >
            ✕
          </button>
        )}
      </div>

      <div style={{ marginBottom: 'var(--space-3)' }}>
        <label className="device-picker-label">
          Microphone
        </label>
        <select
          value={selectedAudioInput}
          onChange={(e) => setSelectedAudioInput(e.target.value)}
          className="device-picker-select"
        >
          {audioInputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {audioOutputs.length > 0 && (
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <label className="device-picker-label">
            Speaker / Output
          </label>
          <select
            value={selectedAudioOutput}
            onChange={(e) => setSelectedAudioOutput(e.target.value)}
            className="device-picker-select"
          >
            {audioOutputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
};
