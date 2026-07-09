interface CanvasPlayHintState {
  mode: string;
  engineState: string;
  sceneType?: string;
  isLiveSession: boolean;
  isPendingScene?: boolean;
  hidePlaybackControls?: boolean;
}

interface PlaybackButtonState {
  isLiveSession: boolean;
  hidePlaybackControls?: boolean;
}

interface AutoPlayControlState {
  hasToggleAutoPlay: boolean;
  hidePlaybackControls?: boolean;
}

export function shouldShowCanvasPlayHint(state: CanvasPlayHintState): boolean {
  return (
    !state.hidePlaybackControls &&
    state.mode === 'playback' &&
    state.engineState !== 'playing' &&
    state.sceneType === 'slide' &&
    !state.isLiveSession &&
    !state.isPendingScene
  );
}

export function shouldShowPlaybackButton(state: PlaybackButtonState): boolean {
  return !state.hidePlaybackControls && !state.isLiveSession;
}

export function shouldShowAutoPlayControl(state: AutoPlayControlState): boolean {
  return !state.hidePlaybackControls && state.hasToggleAutoPlay;
}
