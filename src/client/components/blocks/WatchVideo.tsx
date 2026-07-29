// watch_video — an assigned viewing, played IN the Stage (src/shared/blocks.ts has the contract).
// The embed enforces the snippet: YouTube's iframe player honors both start and end, so the
// learner lands on the passage the tutor named and the player stops when it ends. The deep link
// rides alongside for the honest failure modes — offline, or embedding disabled by the video's
// owner — and because reading the video on YouTube proper is a legitimate choice.
//
// "done watching" is the only producer of { watched: true }. It mints 'exposed' (grading.ts) —
// an encounter, never a mastery refresh — which is why this is a block and not a UI tool.
import { CheckIcon as Check } from '@phosphor-icons/react';
import { atTime, mmss, videoId } from '../../../shared/videoUrl.js';
import { BlockProse } from '../BlockProse.js';

function spanLabel(start?: number, end?: number): string {
  if (start == null && end == null) return '';
  return ` (${mmss(start ?? 0)}–${end != null ? mmss(end) : 'end'})`;
}

export function WatchVideo({ args, result, addResult }: {
  args: any; result: any; addResult: (r: any) => void;
}) {
  const id = videoId(args.url);
  const link = args.startSeconds != null ? atTime(args.url, args.startSeconds) : args.url;
  const label = `${args.title ?? 'the video'}${spanLabel(args.startSeconds, args.endSeconds)}`;

  if (result) {
    return (
      <div className="block watch-video done">
        <span className="graded-tag">{result.grading ? <><Check size={12} weight="bold" aria-hidden /> graded</> : 'submitted'}</span>
        <p>
          {result.watched
            ? <>Watched <a href={link} target="_blank" rel="noreferrer">{label}</a>.</>
            : <>Skipped {label}.</>}
          <span className="wv-note"> Watching counts as an encounter — the next check is what proves it stuck.</span>
        </p>
      </div>
    );
  }

  const params = new URLSearchParams({ rel: '0' });
  if (args.startSeconds != null) params.set('start', String(Math.floor(args.startSeconds)));
  if (args.endSeconds != null) params.set('end', String(Math.floor(args.endSeconds)));

  return (
    <div className="block watch-video">
      <BlockProse text={args.why} />
      {id ? (
        <iframe
          className="wv-player"
          src={`https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`}
          title={args.title ?? 'assigned video'}
          allow="encrypted-media; picture-in-picture"
          allowFullScreen
        />
      ) : null}
      <p className="wv-link">
        <a href={link} target="_blank" rel="noreferrer">
          {id ? 'open on YouTube' : `open ${label}`}
        </a>
        {args.startSeconds != null && <span className="wv-note"> starts at {mmss(args.startSeconds)}</span>}
        {/* Embeds fail two honest ways — offline, or the owner disabled embedding — and the player
            cannot report either from inside its frame; the link is the fallback for both. */}
        {id && <span className="wv-note"> — if the player refuses, the link still works</span>}
      </p>
      <button type="button" onClick={() => addResult({ watched: true })}>
        done watching
      </button>
    </div>
  );
}
