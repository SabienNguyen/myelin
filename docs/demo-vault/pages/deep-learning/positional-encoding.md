---
title: 'Positional Encoding: Giving Attention a Sense of Order'
prereqs:
  - multi-head-attention
deepens: []
tags:
  - transformers
  - attention
  - llm
difficulty: 3
status: solid
sources:
  - 'https://arxiv.org/abs/1706.03762'
  - 'https://arxiv.org/abs/2104.09864'
  - 'https://blog.eleuther.ai/rotary-embeddings/'
---
Self-attention, on its own, is permutation-invariant. $Q$, $K$, and $V$ are produced by linear projections applied independently to each token's embedding — nothing in $\mathrm{softmax}(QK^T/\sqrt{d_k})V$ reads *where* a token sits in the sequence, only *which* tokens it is. Shuffle the input tokens and you get the same set of outputs, shuffled the same way. Order has to be injected from outside the attention operation, or the model literally cannot tell "dog bites man" from "man bites dog."

**Sinusoidal encoding (Vaswani et al., "Attention Is All You Need," 2017).** The original Transformer adds a fixed vector to each token embedding before the first layer:
$$PE_{(pos,2i)} = \sin\left(\frac{pos}{10000^{2i/d_{\text{model}}}}\right), \qquad PE_{(pos,2i+1)} = \cos\left(\frac{pos}{10000^{2i/d_{\text{model}}}}\right)$$
Each dimension pair is a sinusoid, and across dimensions the wavelengths form a geometric progression from $2\pi$ up to $10000\cdot 2\pi$. The authors chose this specific form because, for any fixed offset $k$, $PE_{pos+k}$ can be written as a *linear function* of $PE_{pos}$ — the hope being that the model could learn to attend by relative position using simple linear operations on these encodings. It's additive, fixed (not learned), and — because it's built from a bounded range of positions seen in training — it generalizes poorly to sequence lengths longer than anything the model trained on.

**Rotary position embedding — RoPE (Su et al., "RoFormer: Enhanced Transformer with Rotary Position Embedding," 2021).** RoPE abandons the "add a positional vector" idea entirely. Instead, it *rotates* each query and key vector, pairing up dimensions into 2D subspaces and rotating each pair by an angle proportional to the token's absolute position ($m\theta$ for position $m$). The payoff shows up when you take the dot product between a rotated query at position $m$ and a rotated key at position $n$: the rotation angles combine such that the result depends only on $(m-n)$ — the *relative* distance — even though each vector only ever encoded its own *absolute* position. Relative position falls out as a consequence of the operation rather than something the model has to separately learn to compute from additive absolute encodings.

**What the rotation actually buys you**, per the RoFormer paper and EleutherAI's analysis of it:
1. **Relative position for free.** No architecture changes to attention itself are needed — the relative-distance dependence is a mathematical consequence of rotating instead of adding.
2. **Distance decay.** Because different embedding dimension-pairs rotate at different frequencies (fast-rotating pairs resolve short-range structure, slow-rotating pairs resolve long-range structure), the inner product between far-apart tokens tends to shrink relative to nearby tokens — a soft, built-in recency bias that sinusoidal/learned absolute encodings don't have.
3. **Multiplicative, not additive, injection.** Sinusoidal encoding adds a positional signal to the embedding and hopes downstream linear algebra recovers relative structure; RoPE folds position directly into the same rotation that produces the dot product attention already computes. This composes more cleanly and is a major reason RoPE-based models extrapolate to longer contexts noticeably better than the original sinusoidal scheme — which is why RoPE, not sinusoidal encoding, is what you'll find in Llama, Mistral, and other current LLMs.
