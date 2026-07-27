---
title: 'Multi-Head Attention: Why One Head Isn''t Enough'
prereqs:
  - attention-scaling
deepens: []
tags:
  - transformers
  - attention
  - llm
difficulty: 3
status: solid
sources:
  - 'https://arxiv.org/abs/1905.09418'
  - 'https://arxiv.org/abs/1905.10650'
---
A single head of scaled dot-product attention, $\mathrm{softmax}(QK^T/\sqrt{d_k})V$, produces exactly one attention distribution per query per layer — one weighted mixture of "what to look at." If a token needs to track two unrelated things at once (say, its subject-verb agreement *and* which earlier word it's a coreference for), one softmax can't hold both patterns simultaneously without blurring them together.

Multi-head attention's fix is structural, not exotic: split $Q$, $K$, $V$ into $h$ smaller subspaces (each of dimension $d_k = d_{\text{model}}/h$), run scaled dot-product attention independently and in parallel in each subspace, then concatenate the $h$ outputs and reproject through a learned matrix $W_O$ back to $d_{\text{model}}$. Each head gets its own $W_Q^{(i)}, W_K^{(i)}, W_V^{(i)}$, so each is free to specialize on a different relationship, and $W_O$ lets the model recombine those specialized views.

**Do heads actually specialize, or is this just capacity padding?** Two papers, approaching the question from opposite directions, give a fairly complete answer:

- Voita, Talbot, Moiseev, Sennrich & Titov, *"Analyzing Multi-Head Self-Attention: Specialized Heads Do the Heavy Lifting, the Rest Can Be Pruned"* (ACL 2019), looked at what heads actually *do*. They identify three recurring, linguistically interpretable head types — **positional** heads (attend to a fixed relative offset), **syntactic** heads (track specific dependency relations), and **rare-word** heads (attend to infrequent tokens). Using a pruning method based on stochastic gates and a differentiable relaxation of the $L_0$ penalty, they find these specialized heads are the *last* ones the method chooses to prune — the model is visibly protecting them. On English–Russian WMT, pruning 38 of 48 encoder heads costs only 0.15 BLEU: most heads are doing very little independent work once the specialized few are in place.
- Michel, Levy & Neubig, *"Are Sixteen Heads Really Better than One?"* (NeurIPS 2019), asked how much redundancy this leaves at test time. They find up to ~20% of heads in WMT models and ~40% in BERT can be dropped post-hoc with no noticeable quality loss, and some layers survive being cut to a single head. But the redundancy is not uniform: encoder and decoder self-attention tolerate pruning down to roughly 20% of their heads, while pruning more than 60% of *encoder-decoder (cross-)attention* heads causes catastrophic degradation.

Put together, the two results triangulate the same picture from different sides: per Voita et al., a small number of heads per layer carry an identifiable, specialized linguistic function; per Michel et al., the rest are largely redundant capacity that helps training and robustness but isn't strictly load-bearing at inference — *except* in cross-attention, where distinct heads specializing on different source-side tokens turn out to matter far more, and cutting too many of them breaks the model outright. Multi-head attention isn't "more heads, more power" uniformly; it's a small set of specialized heads doing most of the work, with the amount of safely-prunable slack depending on which attention mechanism the heads sit in.
