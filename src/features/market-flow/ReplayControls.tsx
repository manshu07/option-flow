import { clockOf } from './marketFlowModel';
import { replayRange } from './replayModel';
import type { ReplayManifest } from './feed';
import type { ReplayModeState } from './replayModel';

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
  phone: boolean;
}

export function ReplayControls({ manifest, mode, loading, error, notice, retryableFutures, retryingFutures, cursorLabel, onPlay, onSeek, onRetry, onLive, phone }: ReplayControlsProps) {
  const range = manifest ? replayRange(manifest.start, manifest.end, clockOf) : null;
  return (
    <div className={`mf-replay ${phone ? 'is-sheet' : 'is-popover'}`} role="dialog" aria-label="Market replay">
      <div className="mf-replay__head">
        <div>
          <b>Market replay</b>
          <span>{manifest ? `${manifest.date} · ${manifest.provider.label}` : 'Captured session'}</span>
        </div>
        <button className="mf-replay__close" type="button" aria-label="Close replay" onClick={onLive}>×</button>
      </div>
      {loading ? <p className="mf-replay__message">Loading the captured session…</p> : !manifest ? <div className="mf-replay__message is-error"><p>{error ?? 'No captured replay minutes.'}</p><button data-testid="flow-replay-retry" type="button" onClick={onRetry}>Retry</button></div> : (
        <>
          {error && <div className="mf-replay__message is-error"><p>{error}</p><button data-testid="flow-replay-retry" type="button" onClick={onRetry}>Retry minute</button></div>}
          <div className="mf-replay__range">Captured {range}</div>
          <div className="mf-replay__time" data-testid="flow-replay-time">{cursorLabel ?? '—'}</div>
          <input
            data-testid="flow-replay-slider"
            className="mf-replay__slider"
            type="range"
            min={0}
            max={Math.max(0, manifest.minutes.length - 1)}
            step={1}
            value={Math.min(mode.cursorIndex, Math.max(0, manifest.minutes.length - 1))}
            onChange={event => onSeek(Number(event.currentTarget.value))}
            aria-label="Replay minute"
          />
          <div className="mf-replay__controls">
            <button data-testid="flow-replay-play" type="button" onClick={onPlay}>{mode.playing ? 'Pause' : mode.cursorIndex >= manifest.minutes.length - 1 ? 'Replay again' : 'Play'}</button>
            <button data-testid="flow-replay-live" type="button" onClick={onLive}>Live</button>
          </div>
          {notice && <div className="mf-replay__message is-error"><p>{notice}</p>{retryableFutures && <button data-testid="flow-replay-futures-retry" type="button" disabled={retryingFutures} onClick={onRetry}>{retryingFutures ? 'Retrying…' : 'Retry futures'}</button>}</div>}
        </>
      )}
    </div>
  );
}
