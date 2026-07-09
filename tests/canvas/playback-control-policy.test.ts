import { describe, expect, test } from 'vitest';

import {
  shouldShowAutoPlayControl,
  shouldShowCanvasPlayHint,
  shouldShowPlaybackButton,
} from '@/components/canvas/playback-control-policy';

describe('playback control policy', () => {
  test('keeps normal slide playback affordances in ordinary playback', () => {
    expect(
      shouldShowCanvasPlayHint({
        mode: 'playback',
        engineState: 'idle',
        sceneType: 'slide',
        isLiveSession: false,
        isPendingScene: false,
        hidePlaybackControls: false,
      }),
    ).toBe(true);
    expect(
      shouldShowPlaybackButton({
        isLiveSession: false,
        hidePlaybackControls: false,
      }),
    ).toBe(true);
    expect(
      shouldShowAutoPlayControl({
        hasToggleAutoPlay: true,
        hidePlaybackControls: false,
      }),
    ).toBe(true);
  });

  test('hides lecture playback affordances in reverse challenge mode', () => {
    expect(
      shouldShowCanvasPlayHint({
        mode: 'playback',
        engineState: 'idle',
        sceneType: 'slide',
        isLiveSession: false,
        isPendingScene: false,
        hidePlaybackControls: true,
      }),
    ).toBe(false);
    expect(
      shouldShowPlaybackButton({
        isLiveSession: false,
        hidePlaybackControls: true,
      }),
    ).toBe(false);
    expect(
      shouldShowAutoPlayControl({
        hasToggleAutoPlay: true,
        hidePlaybackControls: true,
      }),
    ).toBe(false);
  });
});
