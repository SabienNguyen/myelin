---
title: 'Why Queries, Keys, and Values'
prereqs: []
deepens: []
tags:
  - transformers
  - attention
  - llm
  - linear-algebra
difficulty: 3
status: solid
sources:
  - 'https://arxiv.org/abs/1706.03762'
  - 'https://sebastianraschka.com/blog/2023/self-attention-from-scratch.html'
  - 'https://ameersaleem.substack.com/p/queries-keys-and-values-in-attention'
---
## The problem

Attention is a mechanism for letting each token pull information from other tokens in the sequence, weighted by relevance. The naive version: take the dot product of raw embeddings $x_i \cdot x_j$ as a relevance score, softmax across $j$, and use those weights to mix the *same* raw embeddings together.

This naive version has two structural problems:

1. **It forces symmetric relevance.** $x_i \cdot x_j = x_j \cdot x_i$ always, for any dot product of a vector with itself-space. But relevance in language is often asymmetric — in "the trophy didn't fit in the suitcase because *it* was too big," the pronoun "it" strongly wants to resolve to "trophy," but "trophy" has no corresponding pull toward "it." A single shared vector space cannot represent that asymmetry.
2. **It overloads one vector with two jobs.** The same vector would have to encode both "what am I, for matching purposes" and "what am I, as content to hand over if selected" — two different jobs competing for the same geometry.

## The fix: three learned projections

Instead of reusing the raw embedding, self-attention learns three separate linear maps $W_Q, W_K, W_V$, applied to each token's embedding $x_i$:

$$q_i = W_Q x_i \qquad k_i = W_K x_i \qquad v_i = W_V x_i$$

- **Query** ($q$): what this token is searching for.
- **Key** ($k$): the index each token advertises about itself, compared against queries.
- **Value** ($v$): the payload actually mixed into the output if selected.

This is the database/dictionary-lookup framing used across several explainers (Raschka, Saleem): the thing you search with (query) and the thing you match against (key) don't have to be the thing you retrieve (value).

Because $W_Q \neq W_K$, the compatibility score $q_i \cdot k_j$ is **no longer forced to equal** $q_j \cdot k_i$. Separate projections make asymmetric relevance representable, directly fixing problem 1. And because $W_V$ is independent of $W_Q, W_K$, the content-mixing job is decoupled from the matching job, fixing problem 2.

### Concrete demonstration

Take 2-D embeddings $x_1=(1,0)$, $x_2=(0,1)$, with

$$W_Q=\begin{pmatrix}1&1\\0&1\end{pmatrix} \qquad W_K=\begin{pmatrix}1&0\\1&1\end{pmatrix}$$

Then $q_1 = W_Q x_1 = (1,0)$, $k_2 = W_K x_2 = (0,1)$, so $q_1 \cdot k_2 = 0$.
But $q_2 = W_Q x_2 = (1,1)$, $k_1 = W_K x_1 = (1,1)$, so $q_2 \cdot k_1 = 2$.

Same two matrices, same four numbers, two genuinely different scores depending on direction — exactly the asymmetry a shared-embedding dot product could never produce.

## The formula

Vaswani et al. (2017), *Attention Is All You Need*, package this as scaled dot-product attention:

$$\text{Attention}(Q,K,V) = \text{softmax}\!\left(\frac{QK^T}{\sqrt{d_k}}\right)V$$

The $\sqrt{d_k}$ scaling term is its own concept — see `attention-scaling`.

## Note on sourcing

WebFetch (full-page reads) was unavailable this session (socket errors on every call); the Raschka and Saleem framing above is drawn from WebSearch result snippets rather than a full close read of either post. The core formula and asymmetry argument are consistent with the original paper.
