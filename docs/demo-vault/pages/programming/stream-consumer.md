---
title: Consuming SSE token streams
prereqs: []
deepens: []
tags: []
difficulty: 3
status: stub
sources:
  - the-gap artifact stream-consumer
---
# Consuming SSE token streams

Stub page, seeded at boot from the-gap's `stream-consumer` artifact (I3 vault wiring). Practice this pattern with a real code exercise — ask the tutor, or use the Library panel's Practice section — rather than reading this stub as the lesson itself.

A stream consumer decodes an incrementally-delivered HTTP response body (the shape LLM chat-completion `stream: true` endpoints return) into discrete events, without assuming any chunk boundary lines up with an event boundary — a single event (or even a multi-byte UTF-8 character) can arrive split across two reads, so both the decoder and the line-splitter carry state across reads instead of assuming one chunk equals one line.

The exercise walks worked example (a sibling pattern, read-only) -> inline completion (one gap) -> full body (the whole function, graded against real tests) — the same sequence the-gap's own ladder enforces.
