import { clockOf } from './marketFlowModel';
import { replayRange } from './replayModel';
import type { ReplayDay, ReplayManifest, ReplaySource } from './feed';
import { isSelectableReplayDay, type ReplayModeState, type ReplaySpeed, type ReplayWindow } from './replayModel';

interface ReplayControlsProps {
  manifest: ReplayManifest | null;
  mode: ReplayModeState;
  loading: boolean;
  error: string | null;
  notice: string | null;
  retryableFutures: boolean;
  retryingFutures: boolean;
  cursorLabel: string | null;
  onPlay: () => void;
  onSeek: (index: number) => void;
  onRetry: () => void;
  onLive: () => void;
  days?: ReplayDay[];
  selectedDate?: string;
  selectedSource?: ReplaySource;
  onSelectDay?: (date: string) => void;
  window?: ReplayWindow;
  customStart?: string;
  customEnd?: string;
  onWindow?: (window: ReplayWindow, start?: string, end?: string) => void;
  speed?: ReplaySpeed;
  onSpeed?: (speed: ReplaySpeed) => void;
  phone: boolean;
}

export function ReplayControls({ manifest, mode, loading, error, notice, retryableFutures, retryingFutures, cursorLabel, onPlay, onSeek, onRetry, onLive, days = [], selectedDate, selectedSource, onSelectDay, window = 'full', customStart = '', customEnd = '', onWindow, speed = 1, onSpeed, phone }: ReplayControlsProps) {
  const range = manifest ? replayRange(manifest.start, manifest.end, clockOf) : null;
  const capturedMinutes = manifest?.minutes ?? [];
  const recent = days.filter(isSelectableReplayDay).slice(0, 3);
  const labelFor = (day: ReplayDay) => `${day.date}${day.source === 'archive' ? ' · archive' : ''}`;
  return (
    <div className={`mf-replay ${phone ? 'is-sheet' : 'is-popover'}`} role="dialog" aria-label="Market replay">
      <div className="mf-replay__head">
        <div>
          <b>Market replay</b>
          <span>{manifest ? `${manifest.date} · ${manifest.provider.label}` : 'Captured session'}</span>
        </div>
        <button className="mf-replay__close" type="button" aria-label="Close replay" onClick={onLive}>×</button>
      </div>
      {days.length > 0 && <div className="mf-replay__days">
        <div className="mf-replay__label">Captured days</div>
        <div className="mf-replay__chips">
          {recent.map(day => <button key={day.date} type="button" className={day.date === selectedDate ? 'is-selected' : ''} onClick={() => onSelectDay?.(day.date)}>{labelFor(day)}</button>)}
        </div>
        <select aria-label="Replay date" value={selectedDate ?? ''} onChange={event => onSelectDay?.(event.currentTarget.value)}>
          {days.map(day => <option key={day.date} value={day.date} disabled={!isSelectableReplayDay(day)}>{labelFor(day)}{!isSelectableReplayDay(day) ? ' · unavailable' : ` · ${day.minutes} min`}</option>)}
        </select>
        {selectedSource && <span className="mf-replay__coverage">Source: {selectedSource} · {days.find(day => day.date === selectedDate)?.minutes ?? 0} captured minutes</span>}
      </div>}
      {loading ? <p className="mf-replay__message">Loading the captured session…</p> : !manifest ? <div className="mf-replay__message is-error"><p>{error ?? 'No captured replay minutes.'}</p><button data-testid="flow-replay-retry" type="button" onClick={onRetry}>Retry</button></div> : (
        <>
          {error && <div className="mf-replay__message is-error"><p>{error}</p>{capturedMinutes.length > 0 && <button data-testid="flow-replay-retry" type="button" onClick={onRetry}>Retry minute</button>}</div>}
          <div className="mf-replay__range">Captured {range}</div>
          <div className="mf-replay__time" data-testid="flow-replay-time">{cursorLabel ?? '—'}</div>
          <div className="mf-replay__selectors">
            <label>Window <select aria-label="Replay window" value={window} onChange={event => onWindow?.(event.currentTarget.value as ReplayWindow, customStart, customEnd)}>
              <option value="full">Full day</option><option value="morning">Morning</option><option value="afternoon">Afternoon</option><option value="last-hour">Last hour</option><option value="custom">Custom</option>
            </select></label>
            {window === 'custom' && <><label>Start <input aria-label="Replay custom start" type="time" value={customStart} onChange={event => onWindow?.('custom', event.currentTarget.value, customEnd)} /></label><label>End <input aria-label="Replay custom end" type="time" value={customEnd} onChange={event => onWindow?.('custom', customStart, event.currentTarget.value)} /></label></>}
            <label>Speed <select aria-label="Replay speed" value={speed} onChange={event => onSpeed?.(Number(event.currentTarget.value) as ReplaySpeed)}><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option></select></label>
          </div>
          <input
            data-testid="flow-replay-slider"
            className="mf-replay__slider"
            type="range"
            min={0}
            max={Math.max(0, capturedMinutes.length - 1)}
            step={1}
            value={Math.min(mode.cursorIndex, Math.max(0, capturedMinutes.length - 1))}
            onChange={event => onSeek(Number(event.currentTarget.value))}
            aria-label="Replay minute"
          />
          <div className="mf-replay__controls">
            <button data-testid="flow-replay-play" type="button" onClick={onPlay}>{mode.playing ? 'Pause' : mode.cursorIndex >= capturedMinutes.length - 1 ? 'Replay again' : 'Play'}</button>
            <button data-testid="flow-replay-live" type="button" onClick={onLive}>Live</button>
          </div>
          {notice && <div className="mf-replay__message is-error"><p>{notice}</p>{retryableFutures && <button data-testid="flow-replay-futures-retry" type="button" disabled={retryingFutures} onClick={onRetry}>{retryingFutures ? 'Retrying…' : 'Retry futures'}</button>}</div>}
        </>
      )}
    </div>
  );
}
