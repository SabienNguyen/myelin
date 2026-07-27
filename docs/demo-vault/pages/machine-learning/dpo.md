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
status: draft
sources: []
---
*Model-knowledge synthesis, not freshly verified this session — no live search was run. This traces the derivation in Rafailov et al., "Direct Preference Optimization" (2023) as I recall it, plus commonly-cited follow-up critiques; treat specifics as unverified until checked against the papers.*

## Setup: the KL-regularized RLHF objective

PPO-RLHF doesn't maximize the reward model alone — it maximizes reward minus a KL penalty back to the reference (SFT) policy:

$$\max_\pi \; \mathbb{E}_{x\sim D,\, y\sim\pi(\cdot|x)}\big[r_\theta(x,y)\big] - \beta\,\mathrm{KL}\big(\pi(\cdot|x)\,\|\,\pi_{\text{ref}}(\cdot|x)\big)$$

## The closed-form optimum

Rearranged, this objective is exactly $-\beta$ times a KL divergence between $\pi$ and a reweighted reference distribution, so it is minimized (KL $=0$) when $\pi$ *equals* that distribution:

$$\pi^*(y|x) = \frac{1}{Z(x)}\,\pi_{\text{ref}}(y|x)\,\exp\!\Big(\frac{r_\theta(x,y)}{\beta}\Big), \qquad Z(x)=\sum_y \pi_{\text{ref}}(y|x)\exp\!\Big(\frac{r_\theta(x,y)}{\beta}\Big)$$

This says: for a *fixed* reward model, the KL-optimal policy is just the reference policy reweighted exponentially by reward and renormalized. $Z(x)$ is a sum over every possible completion of $x$ — intractable to compute. That's why you still need PPO's rollout-based optimization even though you "know" the closed form.

## The DPO trick: invert, then substitute into Bradley-Terry

Solve the closed form for the reward instead of the policy:

$$r_\theta(x,y) = \beta\log\frac{\pi^*(y|x)}{\pi_{\text{ref}}(y|x)} + \beta\log Z(x)$$

The reward model was originally fit on pairwise comparisons via the Bradley-Terry model, $P(y_w \succ y_l|x) = \sigma\big(r_\theta(x,y_w)-r_\theta(x,y_l)\big)$. Substitute:

$$r_\theta(x,y_w)-r_\theta(x,y_l) = \beta\log\frac{\pi^*(y_w|x)}{\pi_{\text{ref}}(y_w|x)} - \beta\log\frac{\pi^*(y_l|x)}{\pi_{\text{ref}}(y_l|x)} + \underbrace{\beta\log Z(x) - \beta\log Z(x)}_{=0}$$

**$Z(x)$ cancels exactly** — because $y_w$ and $y_l$ share the same prompt $x$, the intractable per-prompt normalizer is identical on both sides of every comparison and drops out. That cancellation is the whole trick: the one term you could never compute is also the one term you never need.

## The loss

Reparameterize: let $\pi_\theta$ (the model you're training) stand in for $\pi^*$ directly, and maximize likelihood of the observed preference data under the induced Bradley-Terry model:

$$\mathcal{L}_{\text{DPO}}(\pi_\theta;\pi_{\text{ref}}) = -\mathbb{E}_{(x,y_w,y_l)\sim D}\left[\log\sigma\!\left(\beta\log\frac{\pi_\theta(y_w|x)}{\pi_{\text{ref}}(y_w|x)} - \beta\log\frac{\pi_\theta(y_l|x)}{\pi_{\text{ref}}(y_l|x)}\right)\right]$$

No separate reward model training stage, no rollout sampling, no value function or advantage estimation — just a logistic-regression-shaped loss computed directly from log-probabilities the policy and reference model already assign to the *existing* static preference pairs. The implicit reward is $\hat r(x,y)=\beta\log(\pi_\theta(y|x)/\pi_{\text{ref}}(y|x))$ — "your language model is secretly a reward model."

## What this gives up relative to PPO-RLHF

1. **On-policy vs. off-policy.** PPO samples fresh completions from the *current* policy during training and scores them live with the RM, so the training signal tracks wherever the policy has actually drifted to. DPO only ever trains on the fixed $(y_w,y_l)$ pairs collected upfront (usually from an earlier SFT-model's generations). It never observes what the policy being trained right now actually outputs — no mechanism catches drift into uncovered regions.
2. **The equivalence is a population-level identity, not a training guarantee.** It assumes infinite data and a policy class expressive enough to realize $\pi^*$ exactly. With finite preference data and finite-capacity networks fit by SGD, what you converge to is not guaranteed to be the closed-form optimum.
3. **Known failure mode:** because the loss only depends on the *difference* of log-ratios, it can improve by driving down $\log\pi_\theta(y_l|x)$ without correspondingly raising $\log\pi_\theta(y_w|x)$ — probability mass on both the preferred and dispreferred response can fall together as long as the gap widens. Reported in follow-up analyses of DPO training dynamics (unverified here — check before citing specifics).
4. **No portable reward artifact.** PPO yields a standalone $r_\theta$ reusable for best-of-$n$ reranking, rejection sampling, or monitoring. DPO's implicit reward is only defined relative to the specific $\beta$ and $\pi_{\text{ref}}$ used in training — not a portable scoring function.
5. **No live reward-hacking detection.** PPO's online loop lets you inspect what the current policy generates and re-score or re-annotate it. DPO trains blind to its own current outputs; drift is only discoverable post-hoc.
6. **The trade is real, not just marketing:** PPO is genuinely fiddly (value function, advantage estimation, KL coefficient schedules, reward normalization). DPO's stability and simplicity are the actual reason it's popular — but that simplicity is bought by giving up the online correction loop, not free.
