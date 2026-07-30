// Minimal SSE reader shared by both adapters. Frames may split ANYWHERE across network chunks —
// including mid-token inside a data: line — so bytes are buffered and a frame is only parsed at
// a complete blank-line boundary.

export interface SseFrame {
  event?: string;
  data: string;
}

const FRAME_END = /\r?\n\r?\n/;

export async function* sseFrames(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let m: RegExpExecArray | null;
    while ((m = FRAME_END.exec(buf))) {
      const frame = parseFrame(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
      if (frame) yield frame;
    }
  }
  // Anything left after the stream closes is an unterminated frame; both providers end cleanly
  // (message_stop / [DONE]), so a remainder is truncation and there is nothing safe to parse.
}

function parseFrame(raw: string): SseFrame | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trimStart();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    // comments (:) and other fields (id:, retry:) are irrelevant to both providers
  }
  return data.length === 0 ? null : { event, data: data.join('\n') };
}
