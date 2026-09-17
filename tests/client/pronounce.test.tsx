// @vitest-environment jsdom
// Pronounce holds the mic stream open across a click ("Record") and MediaRecorder's own async
// onstop. The stream used to be released only from onstop, so a throw between getUserMedia and a
// live recorder — or an unmount mid-recording — left the mic held with nothing left to ever call
// .stop() on it. These pin the three release paths that don't reach onstop.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Pronounce } from '../../src/client/components/blocks/Pronounce.js';

function fakeStream() {
  const track = { stop: vi.fn() };
  return { track, stream: { getTracks: () => [track] } as unknown as MediaStream };
}

function stubStage() {
  const stageRoot = document.createElement('div');
  stageRoot.id = 'stage-root';
  document.body.appendChild(stageRoot);
  return stageRoot;
}

const args = { word: 'ba', lang: 'vi', tone: 'sac', toneSystem: 'vi' as const, pageSlug: 's' };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('Pronounce — releasing the mic on paths that never reach onstop', () => {
  it('can transition from recording UI to a completed result without changing hook order', () => {
    stubStage();
    const props = { args, addResult: vi.fn() };
    const view = render(<Pronounce {...props} result={null} />);
    expect(() => view.rerender(<Pronounce {...props} result={{ passes: 1, required: 1, applied: true }} />)).not.toThrow();
    expect(screen.getByText(/1\/1 clean/)).toBeTruthy();
  });
 
  it('stops the stream tracks when MediaRecorder construction throws', async () => {
    const { track, stream } = fakeStream();
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
    class ThrowingRecorder { constructor() { throw new Error('unsupported mime type'); } }
    vi.stubGlobal('MediaRecorder', ThrowingRecorder);

    stubStage();
    render(<Pronounce args={args} result={null} addResult={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pronunciation waiting on the stage' }));
    fireEvent.click(await screen.findByRole('button', { name: /Record/ }));

    await waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
    expect(await screen.findByText(/microphone unavailable/i)).toBeTruthy();
  });

  it('stops the stream tracks when start() throws', async () => {
    const { track, stream } = fakeStream();
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
    class StartThrows {
      ondataavailable: unknown; onstop: unknown;
      start() { throw new Error('already recording'); }
      stop() {}
    }
    vi.stubGlobal('MediaRecorder', StartThrows);

    stubStage();
    render(<Pronounce args={args} result={null} addResult={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pronunciation waiting on the stage' }));
    fireEvent.click(await screen.findByRole('button', { name: /Record/ }));

    await waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
    expect(await screen.findByText(/microphone unavailable/i)).toBeTruthy();
  });

  it('stops a live recorder and its stream on unmount', async () => {
    const { track, stream } = fakeStream();
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
    class FakeRecorder {
      state: 'inactive' | 'recording' = 'inactive';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      stopCalls = 0;
      start() { this.state = 'recording'; }
      stop() { this.stopCalls += 1; this.state = 'inactive'; this.onstop?.(); }
    }
    const made: FakeRecorder[] = [];
    vi.stubGlobal('MediaRecorder', class {
      constructor() {
        const r = new FakeRecorder();
        made.push(r);
        return r as unknown as MediaRecorder;
      }
    });

    stubStage();
    const { unmount } = render(<Pronounce args={args} result={null} addResult={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pronunciation waiting on the stage' }));
    fireEvent.click(await screen.findByRole('button', { name: /Record/ }));
    await waitFor(() => expect(made).toHaveLength(1));

    unmount();
    expect(made[0].stopCalls).toBe(1);
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
