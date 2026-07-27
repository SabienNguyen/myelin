---
title: 'The KV Cache: Why Generation Doesn''t Recompute Everything'
prereqs:
  - positional-encoding
deepens: []
tags:
  - transformers
  - attention
  - llm
  - inference
difficulty: 4
status: solid
sources:
  - 'https://www.morphllm.com/kv-cache-explained'
  - >-
    https://mbrenndoerfer.com/writing/kv-cache-memory-calculation-llm-inference-gpu
---
Autoregressive generation produces one token at a time, and each new step attends over every token generated so far. Naively, that means at step $t$ you'd recompute $K$ and $V$ for *all* $t$ previous tokens before you can even get to the new query — redundant work that grows the total cost of generating $T$ tokens to $O(T^2)$ instead of $O(T)$.

The fix rests on one observation: because of the causal mask, position $i$'s key and value never depend on anything that comes after position $i$. Once $K_i$ and $V_i$ are computed, they are *fixed forever* — nothing later in the sequence changes them. So instead of recomputing them, you cache them: at each new step, you compute $K$ and $V$ only for the *new* token, append them to the cache, and run attention using the full cache. Per-step cost drops from "recompute everything so far" to "compute one new K/V pair, then attend over what's stored."

**Memory formula.** For one layer, one token, the cache stores 2 vectors (one $K$, one $V$) of size $(\text{num\_kv\_heads} \times \text{head\_dim})$ each. Scaling up to the full model and a full batch:

$$\text{cache bytes} = 2 \times \text{num\_layers} \times \text{num\_kv\_heads} \times \text{head\_dim} \times \text{seq\_len} \times \text{bytes\_per\_element} \times \text{batch\_size}$$

The leading 2 is for K and V; `num_kv_heads` may be smaller than the number of query heads under multi-query or grouped-query attention, which is precisely the lever those techniques pull.

**Worked example.** Take a 7B-class model: 32 layers, hidden size 4096 split as 32 heads $\times$ 128 head-dim, FP16 (2 bytes/element), a 4096-token sequence, batch size 2.

- Per token, per layer: $2 \times (32 \times 128) \times 2\text{ bytes} = 16{,}384$ bytes $= 16$ KiB
- Across 32 layers: $16\text{ KiB} \times 32 = 512$ KiB per token
- Across 4096 tokens: $512\text{ KiB} \times 4096 = 2$ GiB
- Across batch size 2: $2\text{ GiB} \times 2 = \mathbf{4\ GiB}$

So a single 4096-token conversation, batched two at a time, already costs 4 GiB just for cached keys and values — on top of the model's own weights (roughly 14 GB in FP16 for a 7B model). The crucial difference is *how* each grows: the weights are a fixed footprint regardless of what you're doing, while the cache grows linearly with both context length and batch size. Push either one up far enough and the cache, not the weights, becomes the memory bottleneck — which is exactly the pressure that motivates multi-query attention (one shared K/V head for all query heads) and grouped-query attention (K/V shared across groups of query heads): both directly shrink `num_kv_heads` in the formula above.
