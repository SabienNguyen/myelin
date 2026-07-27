---
title: Outlier Features and Why Naive int4 Quantization Wrecks Perplexity
prereqs: []
deepens: []
tags:
  - quantization
  - llm-inference
  - efficiency
difficulty: 4
status: solid
sources:
  - 'https://arxiv.org/abs/2208.07339'
  - 'https://timdettmers.com/2022/08/17/llm-int8-and-emergent-features/'
  - 'https://arxiv.org/abs/2210.17323'
  - 'https://arxiv.org/abs/2306.00978'
---
## The claim to unlearn

"4 bits isn't enough precision" is the wrong diagnosis. int4 gives 16 representable levels per value — plenty, if every weight or activation in a tensor needed roughly the same dynamic range. The real failure is **scale allocation**, not bit budget, and three papers (LLM.int8(), GPTQ, AWQ) each demonstrate this a different way while converging on the same diagnosis.

## What the outlier-feature numbers actually show

Dettmers et al. (LLM.int8(), 2022) define an "outlier feature" operationally: a dimension whose magnitude reaches at least 6.0, appearing in at least 25% of a model's layers and at least 6% of sequence positions. Below roughly 6.7B parameters these are rare and scattered. Between 6B and 6.7B parameters the paper finds a sharp phase transition — the fraction of layers carrying outliers jumps from 65% to 100%, and the fraction of affected sequence positions jumps from 35% to 75%, over a narrow band of scale. Past that point the outliers are systematic: the same feature dimensions recur across layers and inputs, not noise. (Dettmers elaborates on this "emergent features" phase shift in a companion blog post, timdettmers.com/2022/08/17.)

The dimensions themselves are a tiny sliver — on the order of 0.1% of features — but Dettmers reports that leaving them in a naive quantization scheme degrades validation perplexity by 600–1000%. The mechanism is exactly the shared-scale problem: a per-tensor (or per-row) int8/int4 scheme sets its range from the extremes present, so a handful of magnitude-6+ outliers stretch that range far past what the other 99.9% of values need. Most quantization bins then sit empty, and the small, information-carrying values collapse toward zero — precision that should have gone to the bulk of the tensor was spent covering outliers instead.

## Three fixes, three ways of reallocating the same bit budget

**LLM.int8() (Dettmers, Lewis, Belkada & Zettlemoyer, 2022, arXiv:2208.07339)** — decomposes each matrix multiply: outlier feature dimensions are multiplied in fp16, the remaining ~99.9% of dimensions are multiplied in int8, and the results are recombined. Mixed precision, but only where it's needed — the shared int8 scale is never distorted by the extremes because they're routed around it entirely.

**GPTQ (Frantar, Ashkboos, Hoefler & Alistarh, 2022, arXiv:2210.17323)** — stays single-precision (down to 4, 3, or even 2 bits) but compensates instead of avoiding. It builds on Optimal Brain Quantization: quantize one weight, then use second-order (Hessian) information to update every not-yet-quantized weight in that row to absorb the error just introduced. GPTQ's improvement over OBQ batches this per column with a shared Hessian across rows, and stabilizes the required Hessian-inverse computation with a Cholesky decomposition — which is what makes it tractable at GPT-scale (a 175B model quantizes in about four GPU-hours). Error from the outlier-driven rounding doesn't compound uncorrected down the layer; it gets pushed into weights that haven't been touched yet.

**AWQ (Lin, Tang, Tang, Yang et al., 2023, arXiv:2306.00978)** — finds that the weights worth protecting are identified by *activation* magnitude, not weight magnitude: 0.1–1% of channels, multiplied by systematically large activations, dominate the layer's output error if quantized coarsely. Rather than carving those channels out into mixed precision (hardware-unfriendly), AWQ rescales: for weight matrix W and activation X, a diagonal per-channel scale matrix S gives WX = (WS)(S⁻¹X) — an identity in full precision, but by shrinking the salient channels' relative quantization error before rounding, it changes how error is distributed across the *same* int4 grid. No backprop, no reconstruction against a calibration set — which is also why it generalizes to instruction-tuned and multimodal models the reconstruction-based methods overfit on.

## The common thread

None of these methods add bits. LLM.int8() moves 0.1% of the computation to higher precision and leaves the rest at 8 bits; GPTQ and AWQ stay at 4 bits throughout and instead change *where the rounding error goes* — compensated forward (GPTQ) or shrunk pre-emptively via rescaling (AWQ). All three report getting within a few percent of full-precision perplexity at the same nominal bit-width naive quantization used. The naive method wasn't undersupplied on bits; it was spending them on the wrong 0.1% of the tensor.

## Sources

- Dettmers, Lewis, Belkada & Zettlemoyer, "LLM.int8(): 8-bit Matrix Multiplication for Transformers at Scale," arXiv:2208.07339 (2022) — https://arxiv.org/abs/2208.07339
- Dettmers, "LLM.int8() and Emergent Features," blog companion to the above — https://timdettmers.com/2022/08/17/llm-int8-and-emergent-features/
- Frantar, Ashkboos, Hoefler & Alistarh, "GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers," arXiv:2210.17323 (2022, ICLR 2023) — https://arxiv.org/abs/2210.17323
- Lin, Tang, Tang, Yang et al., "AWQ: Activation-aware Weight Quantization for LLM Compression and Acceleration," arXiv:2306.00978 (2023, MLSys 2024) — https://arxiv.org/abs/2306.00978

Read via web search/fetch during a live session (2026-07-27); figures above are the papers' own reported numbers, not re-derived.
