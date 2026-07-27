---
title: 'Why Scale by √d_k: The Variance Argument'
prereqs:
  - qkv-attention
deepens: []
tags:
  - transformers
  - attention
  - llm
  - probability
difficulty: 3
status: solid
sources:
  - 'https://arxiv.org/abs/1706.03762'
  - >-
    https://d2l.ai/chapter_attention-mechanisms-and-transformers/attention-scoring-functions.html
  - 'https://ameersaleem.substack.com/p/multi-head-attention-why-one-head'
---
## The claim to justify

Scaled dot-product attention (see `qkv-attention`) divides the raw score by $\sqrt{d_k}$:

$$\text{Attention}(Q,K,V) = \text{softmax}\!\left(\frac{QK^T}{\sqrt{d_k}}\right)V$$

"It keeps softmax gradients healthy" is the one-line folk version. The actual argument, per the footnote in Vaswani et al. (2017) and confirmed against the D2L.ai textbook treatment, is a variance computation.

## The variance derivation

Assume each component of $q, k \in \mathbb{R}^{d_k}$ is an independent random variable with mean $0$, variance $1$ (roughly true early in training under standard initialization). For one coordinate:

$$\mathbb{E}[q_ik_i] = \mathbb{E}[q_i]\mathbb{E}[k_i] = 0 \qquad \text{Var}(q_ik_i) = \mathbb{E}[q_i^2]\mathbb{E}[k_i^2] = 1$$

The dot product sums $d_k$ independent terms like this:

$$q\cdot k = \sum_{i=1}^{d_k} q_ik_i \implies \text{Var}(q\cdot k) = \sum_{i=1}^{d_k}\text{Var}(q_ik_i) = d_k$$

So the standard deviation of the raw score grows like $\sqrt{d_k}$ — purely from summing more dimensions, carrying zero extra "relatedness" signal. A model with $d_k = 512$ produces routinely larger-magnitude scores than one with $d_k = 64$, for a reason that has nothing to do with what the tokens mean.

## Why that breaks softmax

Softmax is scale-sensitive. Large-magnitude, widely-spread logits push softmax toward saturation — nearly all probability mass on the single largest entry. Near that saturated regime, $\partial\,\text{softmax}_i/\partial z_j \to 0$ (softmax's Jacobian is built from $p_i(1-p_i)$-type terms that vanish near 0 or 1). Gradients through attention vanish and learning stalls.

## Why √d_k specifically

Variance scaling gives the exact right normalizer: for a constant $a$, $\text{Var}(aX) = a^2\text{Var}(X)$. Setting $a = 1/\sqrt{d_k}$:

$$\text{Var}\left(\frac{q\cdot k}{\sqrt{d_k}}\right) = \frac{\text{Var}(q\cdot k)}{d_k} = \frac{d_k}{d_k} = 1$$

regardless of $d_k$. Worked numerically: for $d_k = 256$, $\text{Var}(q\cdot k) = 256$, and $\text{Var}(q\cdot k/\sqrt{256}) = 256/256 = 1$. Whatever dimension a given model or attention head uses, the score distribution lands back at the same dimension-independent scale — softmax stays in a well-conditioned regime instead of saturating as $d_k$ grows.

## Note on sourcing

WebFetch (full-page reads) was unavailable this session; the D2L.ai and Saleem framing is drawn from WebSearch snippets, cross-checked against each other and against the well-known original-paper footnote, rather than a full close read of either secondary source.
