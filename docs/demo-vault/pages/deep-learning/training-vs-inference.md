---
title: 'Training vs. Inference: Teacher Forcing and the Causal Mask'
prereqs:
  - kv-cache
deepens: []
tags:
  - transformers
  - attention
  - llm
  - training
difficulty: 4
status: solid
sources:
  - 'https://arxiv.org/abs/1906.07651'
  - 'https://arxiv.org/abs/1905.10617'
---
Training and inference run the *same* model through *structurally different* computations.

**Training** feeds a whole target sequence through the model in **one parallel forward pass**. A causal mask ensures position $i$'s attention only looks at positions $\le i$, so no position can see the future even though every position is computed simultaneously. Crucially, this is only valid because of **teacher forcing**: at every position, the input the model conditions on is the *ground-truth* previous token from the training data — not whatever the model itself would have predicted. Because the correct next-token target never depends on the model's own output at the previous step, there's no sequential dependency between positions, and the whole sequence can be processed in one shot with every $K$ and $V$ computed exactly once.

**Inference** has no such luxury: there is no ground truth to feed at position $t+1$, only the model's own sampled token at position $t$. That makes generation inherently sequential — position $t+1$ literally cannot be computed until position $t$'s token has been produced. This sequential structure is exactly what the KV cache exists to make tractable: since you're forced to go one step at a time anyway, caching avoids *also* recomputing every prior key and value at each of those unavoidable steps.

**Exposure bias** is the name for the gap this asymmetry creates: a model trained exclusively on ground-truth prefixes never practices recovering from its *own* mistakes, so the worry is that a single early error at inference time nudges the model into a distribution it never saw during training, compounding into larger errors downstream.

**The honest empirical picture is more equivocal than that story suggests.** Two sources, approaching from different angles, land in a similar place:

- Mihaylova & Martins, *"Scheduled Sampling for Transformers"* (2019), extend Bengio et al.'s scheduled-sampling fix (mixing model predictions into training inputs) to the Transformer setting, but note in passing that Transformer-based models exhibit *less* exposure bias than RNN-based ones in the first place — attention over the whole generated prefix, rather than a single compressed hidden state, appears to be inherently more forgiving of small earlier errors.
- He, Zhang, Zhou & Glass, *"Quantifying Exposure Bias for Neural Language Generation"* (2019), measured it directly rather than arguing about it, using metrics (EB-BLEU, EB-C) built on a model's own self-recovery ability. Across LSTM and Transformer models, on both synthetic and real seq2seq/language-generation tasks, they found the measured gap attributable to exposure bias was only around 3% — small enough that they conclude it is either trivial or indistinguishable from ordinary model/data-distribution mismatch, and explicitly question whether techniques built to combat it are worth their added complexity.

Read together, both sources push against the intuitive "one error snowballs" narrative, though from different evidence: per Mihaylova & Martins, it's an architectural comparison (Transformers are just less exposed than RNNs to begin with); per He et al., it's a direct measurement showing the effect is small in absolute terms regardless of architecture. Exposure bias is a real, well-defined mismatch between training and inference — but the case that it's a *large* practical problem for Transformer-based models is weaker than the folk version of the story implies.

This is also the direct answer to "would a KV cache help training?" — no. Teacher forcing plus the causal mask means training has no sequential decode steps to amortize in the first place; every K and V is computed exactly once, in the one parallel pass, and consumed via the mask in that same pass. The cache only earns its keep when the ground truth is unavailable and generation has to proceed one token at a time.
