import { describe, it, expect } from 'vitest';
import { atTime, isVideoUrl, mmss, videoId } from '../src/shared/videoUrl.js';

describe('videoId', () => {
  it('extracts the id from every URL shape isVideoUrl accepts', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123',
      'https://youtu.be/dQw4w9WgXcQ?t=30',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
    ]) {
      expect(isVideoUrl(url), url).toBe(true);
      expect(videoId(url), url).toBe('dQw4w9WgXcQ');
    }
  });
  it('null for anything without an id — the block then renders a plain link', () => {
    expect(videoId('https://example.com/watch?v=nope')).toBeNull();
    expect(videoId('https://vimeo.com/12345')).toBeNull();
  });
});

describe('atTime / mmss', () => {
  it('appends t= with the right separator', () => {
    expect(atTime('https://youtu.be/x', 90)).toBe('https://youtu.be/x?t=90s');
    expect(atTime('https://www.youtube.com/watch?v=x', 90.9)).toBe('https://www.youtube.com/watch?v=x&t=90s');
  });
  it('mmss renders M:SS and H:MM:SS', () => {
    expect(mmss(0)).toBe('0:00');
    expect(mmss(225)).toBe('3:45');
    expect(mmss(3725)).toBe('1:02:05');
  });
});
