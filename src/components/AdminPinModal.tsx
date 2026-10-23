import React, { useState } from 'react';
import { Lock, X, ChevronLeft } from 'lucide-react';

interface AdminPinModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (role: 'Manager' | 'Committee') => void;
  targetRole: 'Manager' | 'Committee';
}

export const AdminPinModal: React.FC<AdminPinModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  targetRole
}) => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const correctPin = targetRole === 'Manager' ? '1111' : '2222';

  const handleKeyPress = (num: string) => {
    setError('');
    if (pin.length < 4) {
      const newPin = pin + num;
      setPin(newPin);
      if (newPin.length === 4) {
        verifyPin(newPin);
      }
    }
  };

  const handleBackspace = () => {
    setError('');
    setPin(prev => prev.slice(0, -1));
  };

  const verifyPin = (currentPin: string) => {
    if (currentPin === correctPin) {
      onSuccess(targetRole);
      setPin('');
      setError('');
    } else {
      setError('Invalid PIN. Please try again.');
      setPin('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
      <div className="bg-white w-full max-w-[340px] rounded-3xl overflow-hidden shadow-2xl border border-[var(--mv-border)] animate-fade-in animate-scale-up">
        {/* Header */}
        <div className="p-4 flex items-center justify-between border-b border-[var(--mv-border)]">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-[var(--mv-accent-soft)] text-[var(--mv-accent)] rounded-lg">
              <Lock className="w-4 h-4" />
            </div>
            <span className="font-semibold text-xs text-gray-900 tracking-tight uppercase">Admin Verification</span>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-full transition-colors text-gray-400"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 text-center">
          <p className="text-xs text-gray-500 font-medium tracking-tight mb-1">PROMPT REQUIRED FOR ACCESS</p>
          <h3 className="font-bold text-[var(--mv-ink)] text-sm mb-1 leading-snug">
            Enter {targetRole} PIN
          </h3>
          <p className="text-[10px] text-gray-400 mb-2 bg-gray-50 py-1 px-2 rounded-lg inline-block">
            Suggestion: Use PIN <strong className="text-[var(--mv-accent)]">{correctPin}</strong> for testing
          </p>

          <p className="text-[10px] font-semibold text-[var(--mv-accent)] mb-4 bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] py-1.5 px-2.5 rounded-lg flex items-center justify-center gap-1.5">
            📱 Please do this verification on mobile
          </p>

          {/* Dots Indicator */}
          <div className="flex justify-center gap-3 my-4">
            {[0, 1, 2, 3].map((index) => (
              <div
                key={index}
                className={`w-3.5 h-3.5 rounded-full border transition-all duration-150 ${
                  index < pin.length
                    ? 'bg-[var(--mv-accent)] border-[var(--mv-accent)] scale-110 shadow-xs'
                    : 'bg-white border-gray-300'
                }`}
              />
            ))}
          </div>

          {error && (
            <p className="text-[11px] text-black bg-black/5 py-1 px-2.5 rounded-lg inline-block font-semibold mt-1">
              {error}
            </p>
          )}
        </div>

        {/* Numeric PIN Pad */}
        <div className="bg-gray-50/70 p-4 border-t border-[var(--mv-border)] grid grid-cols-3 gap-3">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
            <button
              key={num}
              onClick={() => handleKeyPress(num)}
              className="py-3 font-semibold text-base text-[var(--mv-ink)] bg-white border border-[var(--mv-border)] rounded-2xl active:bg-gray-100 active:scale-95 transition-all shadow-xs flex items-center justify-center"
            >
              {num}
            </button>
          ))}
          <div className="flex items-center justify-center">
            <span className="text-[10px] font-semibold text-gray-400 tracking-tight uppercase">SECURE</span>
          </div>
          <button
            onClick={() => handleKeyPress('0')}
            className="py-3 font-semibold text-base text-[var(--mv-ink)] bg-white border border-[var(--mv-border)] rounded-2xl active:bg-gray-100 active:scale-95 transition-all shadow-xs flex items-center justify-center"
          >
            0
          </button>
          <button
            onClick={handleBackspace}
            className="py-3 font-semibold text-sm text-gray-900 bg-white border border-[var(--mv-border)] rounded-2xl active:bg-gray-100 active:scale-95 transition-all shadow-xs flex items-center justify-center"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
};
