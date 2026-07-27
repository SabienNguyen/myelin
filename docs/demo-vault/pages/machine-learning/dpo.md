---
title: 'DPO: The Reward Model You Get For Free'
prereqs:
  - rlhf-reward-model
deepens: []
tags:
  - rlhf
  - dpo
  - alignment
difficulty: 5
status: solid
sources:
  - 'https://arxiv.org/abs/2305.18290'
  - 'https://arxiv.org/abs/2402.13228'
  - 'https://arxiv.org/abs/2203.02155'
---
Rafailov, Sharma, Mitchell, Ermon, Manning & Finn, "Direct Preference Optimization: Your Language
Model is Secretly a Reward Model," arXiv:2305.18290 (2023, NeurIPS 2023). This traces their
derivation and reports their own experimental claims.

## Setup: the KL-regularized RLHF objective

PPO-RLHF (InstructGPT's stage 3 — see the reward-model page) doesn't maximize the reward model
alone — it maximizes reward minus a KL penalty back to the reference (SFT) policy:

$$\max_\pi \; \mathbb{E}_{x\sim D,\, y\sim\pi(\cdot|x)}\big[r_\theta(x,y)\big] - \beta\,\mathrm{KL}\big(\pi(\cdot|x)\,\|\,\pi_{\text{ref}}(\cdot|x)\big)$$

## The closed-form optimum

Rafailov et al. show this objective is exactly $-\beta$ times a KL divergence between $\pi$ and a
reweighted reference distribution, so it is minimized (KL $=0$) when $\pi$ *equals* that
distribution:

$$\pi^*(y|x) = \frac{1}{Z(x)}\,\pi_{\text{ref}}(y|x)\,\exp\!\Big(\frac{r_\theta(x,y)}{\beta}\Big), \qquad Z(x)=\sum_y \pi_{\text{ref}}(y|x)\exp\!\Big(\frac{r_\theta(x,y)}{\beta}\Big)$$

This says: for a *fixed* reward model, the KL-optimal policy is just the reference policy
reweighted exponentially by reward and renormalized. $Z(x)$ is a sum over every possible completion
of $x$ — intractable to compute. The paper's own framing for why PPO exists despite this closed
form: you "know" the optimal policy's shape but can't evaluate its normalizer, so rollout-based
optimization is the fallback.

## The DPO trick: invert, then substitute into Bradley-Terry

Rafailov et al.'s central move is solving the closed form for the reward instead of the policy:

$$r_\theta(x,y) = \beta\log\frac{\pi^*(y|x)}{\pi_{\text{ref}}(y|x)} + \beta\log Z(x)$$

The reward model was originally fit on pairwise comparisons via the Bradley-Terry model (see the
reward-model page), $P(y_w \succ y_l|x) = \sigma\big(r_\theta(x,y_w)-r_\theta(x,y_l)\big)$.
Substitute:

$$r_\theta(x,y_w)-r_\theta(x,y_l) = \beta\log\frac{\pi^*(y_w|x)}{\pi_{\text{ref}}(y_w|x)} - \beta\log\frac{\pi^*(y_l|x)}{\pi_{\text{ref}}(y_l|x)} + \underbrace{\beta\log Z(x) - \beta\log Z(x)}_{=0}$$

**$Z(x)$ cancels exactly** — because $y_w$ and $y_l$ share the same prompt $x$, and (per the
paper) the partition function does not depend on $y$, the intractable per-prompt normalizer is
identical on both sides of every comparison and drops out. That cancellation is the whole trick:
the one term you could never compute is also the one term you never need.

## The loss

Reparameterize: let $\pi_\theta$ (the model you're training) stand in for $\pi^*$ directly, and
maximize likelihood of the observed preference data under the induced Bradley-Terry model:

$$\mathcal{L}_{\text{DPO}}(\pi_\theta;\pi_{\text{ref}}) = -\mathbb{E}_{(x,y_w,y_l)\sim D}\left[\log\sigma\!\left(\beta\log\frac{\pi_\theta(y_w|x)}{\pi_{\text{ref}}(y_w|x)} - \beta\log\frac{\pi_\theta(y_l|x)}{\pi_{\text{ref}}(y_l|x)}\right)\right]$$

No separate reward model training stage, no rollout sampling, no value function or advantage
estimation — just a logistic-regression-shaped loss computed directly from log-probabilities the
policy and reference model already assign to the *existing* static preference pairs. The implicit
reward is $\hat r(x,y)=\beta\log(\pi_\theta(y|x)/\pi_{\text{ref}}(y|x))$ — the paper's own line:
"your language model is secretly a reward model." Rafailov et al. report DPO matching or exceeding
PPO-based RLHF on the three tasks they test — controlled sentiment generation, summarization, and
single-turn dialogue — while being simpler to train (no reward model stage, no online sampling).

## What this gives up relative to PPO-RLHF

1. **On-policy vs. off-policy.** PPO samples fresh completions from the *current* policy during
   training and scores them live with the RM, so the training signal tracks wherever the policy
   has actually drifted to. DPO only ever trains on the fixed $(y_w,y_l)$ pairs collected upfront
   (usually from an earlier SFT-model's generations). It never observes what the policy being
   trained right now actually outputs — no mechanism catches drift into uncovered regions.
2. **The equivalence is a population-level identity, not a training guarantee.** It assumes
   infinite data and a policy class expressive enough to realize $\pi^*$ exactly. With finite
   preference data and finite-capacity networks fit by SGD, what you converge to is not guaranteed
   to be the closed-form optimum.
3. **Known failure mode: chosen and rejected probability can shrink together.** Because the loss
   only depends on the *difference* of log-ratios, gradient descent can satisfy it by driving down
   $\log\pi_\theta(y_l|x)$ without correspondingly raising $\log\pi_\theta(y_w|x)$ — both can fall
   as long as the gap widens. Pal et al., "Smaug: Fixing Failure Modes of Preference Optimisation
   with DPO-Positive," arXiv:2402.13228 (2024), name this precisely and show it's worst when the
   chosen/rejected completions are close in edit distance; their fix (DPOP) adds a penalty term
   that keeps the preferred completion's likelihood from dropping below its reference-model value.
4. **No portable reward artifact.** PPO yields a standalone $r_\theta$ reusable for best-of-$n$
   reranking, rejection sampling, or monitoring. DPO's implicit reward is only defined relative to
   the specific $\beta$ and $\pi_{\text{ref}}$ used in training — not a portable scoring function.
5. **No live reward-hacking detection.** PPO's online loop lets you inspect what the current
   policy generates and re-score or re-annotate it. DPO trains blind to its own current outputs;
   drift is only discoverable post-hoc.
6. **The trade is real, not just marketing:** PPO is genuinely fiddly (value function, advantage
   estimation, KL coefficient schedules, reward normalization). DPO's stability and simplicity are
   the actual reason it's popular — but that simplicity is bought by giving up the online
   correction loop, not free.

## Sources

- Rafailov, Sharma, Mitchell, Ermon, Manning & Finn, "Direct Preference Optimization: Your
  Language Model is Secretly a Reward Model," arXiv:2305.18290 (2023) —
  https://arxiv.org/abs/2305.18290
- Pal, Golechha, Vora, Garg & Palanisamy, "Smaug: Fixing Failure Modes of Preference Optimisation
  with DPO-Positive," arXiv:2402.13228 (2024) — https://arxiv.org/abs/2402.13228
- Ouyang et al. (2022), InstructGPT, arXiv:2203.02155 — for the PPO-RLHF baseline this page
  contrasts against (see the reward-model page for full citation)

Read via web search during a live session (2026-07-27); figures and framing above are the papers'
own reported claims.
