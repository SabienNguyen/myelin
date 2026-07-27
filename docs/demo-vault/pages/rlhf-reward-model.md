---
title: 'The Reward Model: Learning From Pairwise Preferences'
prereqs: []
deepens: []
tags:
  - rlhf
  - alignment
  - reward-model
difficulty: 4
status: draft
sources:
  - >-
    unverified model knowledge — not sourced this session; based on Christiano
    et al. 2017 and InstructGPT (Ouyang et al. 2022) as recalled from training,
    not fetched live
---
## The setup

You don't have humans rate completions on an absolute scale (people are bad at that — inconsistent
across raters and across time). Instead you show a human a prompt `x` and two completions
`y_w` (chosen/"win") and `y_l` (rejected/"lose"), and ask which is better. That's cheap and
consistent to collect.

## Turning comparisons into a scalar reward: Bradley-Terry

The reward model is a network `r_θ(x, y)` that outputs a single scalar "goodness" score for a
(prompt, completion) pair — usually the base LM with its unembedding head swapped for a scalar
head. The question is: what objective makes a *scalar* fall out of *pairwise* judgments?

The Bradley-Terry model answers this. It assumes the probability that `y_w` beats `y_l` is a
logistic function of the *difference* in their underlying scores:

$$P(y_w \succ y_l \mid x) = \sigma\big(r_\theta(x, y_w) - r_\theta(x, y_l)\big)$$

Training minimizes the negative log-likelihood of the observed human choices under this model:

$$\mathcal{L}(\theta) = -\log \sigma\big(r_\theta(x, y_w) - r_\theta(x, y_l)\big)$$

This is exactly logistic regression, where the "feature difference" is a learned difference of
two forward passes through the same network rather than a fixed feature vector.

## What this implies (and doesn't)

- The reward model never sees or fits an absolute scale — only differences. So `r_θ` is only
  identified up to an additive constant *per prompt*: if you shift every reward for a given `x`
  by the same amount, every pairwise probability is unchanged. There's no such thing as "this
  completion has reward 4.2" in an absolute sense — only "this beats that by roughly this much."
- Rewards across *different* prompts aren't comparable on the same footing either, since the
  additive shift can differ per prompt.
- The RM only learns what's implicit in the comparisons it was trained on. If annotators
  systematically prefer longer, more confident-sounding, or more agreeable completions regardless
  of correctness, the RM learns *that* — reward hacking downstream (in RL against this RM) exploits
  exactly these spurious regularities, since the RM is the only signal the policy ever sees.
