---
title: How Transformers Actually Work
pages:
  - qkv-attention
  - attention-scaling
  - multi-head-attention
  - positional-encoding
  - kv-cache
  - training-vs-inference
---
Not the pop-sci version — the actual mechanism, built up in the order each piece becomes necessary.

We start with self-attention's central design choice: why queries, keys, and values are three separate learned projections instead of one. The naive alternative — dot-product the raw embeddings for both relevance and content — is symmetric by construction and can't represent one-directional relationships like a pronoun resolving to its antecedent. Splitting Q/K/V breaks that symmetry and separates "what matches" from "what gets carried."

From there, `attention-scaling` derives why raw dot-product scores get divided by √d_k — not a stability heuristic but a variance computation: summing d_k independent unit-variance terms grows the score's standard deviation like √d_k, which saturates softmax and kills its gradient. Dividing by √d_k is the exact normalizer that cancels that growth for any d_k.

`multi-head-attention` asks why one attention pattern per layer isn't enough, and how splitting Q/K/V into narrower subspaces lets a layer track several relationships (syntax, coreference, ...) at once. `positional-encoding` confronts the fact that none of the above has any notion of token order — attention is permutation-invariant on its own — and covers how order gets injected back in (sinusoidal, learned, rotary). `kv-cache` moves from training-time parallelism to inference-time reality: why generating one token at a time would otherwise recompute every previous token's keys and values, and how caching them turns that into a cheap append. Finally `training-vs-inference` closes the loop: why training processes a whole sequence at once under a causal mask with teacher forcing, while inference is sequential — and why the KV cache is precisely what makes that asymmetry workable in practice.

Two pages are written and sourced (qkv-attention, attention-scaling); the remaining four are stubs waiting to be taught in later sessions.
