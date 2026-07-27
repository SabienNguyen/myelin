---
title: 'The Reward Model: Learning From Pairwise Preferences'
prereqs: []
deepens: []
tags:
  - rlhf
  - alignment
  - reward-model
difficulty: 4
status: solid
sources:
  - 'https://arxiv.org/abs/1706.03741'
  - 'https://arxiv.org/abs/2203.02155'
---
## The setup

You don't have humans rate completions on an absolute scale (people are bad at that — inconsistent
across raters and across time). Instead you show a human a prompt `x` and completions, and ask
which is better. That's cheap and consistent to collect.

Christiano et al. (2017), the paper that established this approach for RL more broadly (Atari,
MuJoCo continuous control — before it was applied to language models at all), show just how
cheap: **700 pairwise queries were enough for simulated robotics tasks (MuJoCo) to match agents
trained on the true, hand-engineered reward function**, and 5,500 queries sufficed for Atari. The
striking result isn't the comparison mechanism alone — it's that a scalar reward learned purely
from "which of these two did you like better" judgments substitutes for a reward function humans
never had to write down.

Ouyang et al. (2022, "InstructGPT") ports this into language modeling as the second of three
pipeline stages: (1) supervised fine-tuning (SFT) on demonstration data, (2) train a reward model
on human comparisons of SFT-model outputs, (3) use that reward model to drive PPO. Labelers rank
K = 4 to 9 model completions per prompt (not just pick a winner from a pair) — but the reward
model is still trained on the resulting pairwise comparisons: ranking K completions yields (K
choose 2) pairs, all sharing one prompt. InstructGPT feeds all of a prompt's pairs through the RM
as a single batch element (one forward pass, not (K choose 2) separate ones) — a compute-saving
choice that turned out to require care, since those pairs are highly correlated and the RM
overfits within a single epoch if the loss isn't reweighted per prompt.

## Turning comparisons into a scalar reward: Bradley-Terry

The reward model is a network `r_θ(x, y)` that outputs a single scalar "goodness" score for a
(prompt, completion) pair — in both papers, a pretrained network with its output head replaced by
a scalar head (InstructGPT initializes this from the 6B SFT model). The question is: what
objective makes a *scalar* fall out of *pairwise* judgments?

The Bradley-Terry model answers this — it's the shared mathematical core both Christiano et al.
and Ouyang et al. use. It assumes the probability that `y_w` beats `y_l` is a logistic function of
the *difference* in their underlying scores:

$$P(y_w \succ y_l \mid x) = \sigma\big(r_\theta(x, y_w) - r_\theta(x, y_l)\big)$$

Training minimizes the negative log-likelihood (equivalently, cross-entropy) of the observed human
choices under this model:

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
  exactly these spurious regularities, since the RM is the only signal the policy ever sees. This
  is the concern InstructGPT's KL penalty against the SFT policy (see the DPO page) is explicitly
  there to limit: it caps how far the policy can drift while chasing the RM's score.

## Sources

- Christiano, Leike, Brown, Martic, Legg & Amodei, "Deep Reinforcement Learning from Human
  Preferences," arXiv:1706.03741 (2017) — https://arxiv.org/abs/1706.03741
- Ouyang, Wu, Jiang, Almeida et al., "Training Language Models to Follow Instructions with Human
  Feedback" (InstructGPT), arXiv:2203.02155 (2022) — https://arxiv.org/abs/2203.02155

Read via web search during a live session (2026-07-27); figures above are the papers' own reported
numbers.
