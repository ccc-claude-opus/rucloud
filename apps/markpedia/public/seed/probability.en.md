> Filed under: [Natural Sciences](#/p/cat-li) › [Statistics and data analysis](#/p/cat-statistics)

## Overview

**Probability** is a number between $0$ and $1$ measuring how likely an event is to occur, and it is the core language for dealing with uncertainty. Probability theory supplies the shared mathematical basis for statistical inference, signal processing, risk assessment and machine learning.

## Definitions and axioms

The classical definition expresses the share of equally likely outcomes contained in event $A$ as $P(A) = \frac{|A|}{|\Omega|}$ when all outcomes are equiprobable. Kolmogorov instead axiomatised probability, requiring $P(\Omega) = 1$ together with $P(A) \ge 0$ and additivity over disjoint events. Conditional probability is $P(A|B) = \frac{P(A \cap B)}{P(B)}$ while Bayes' theorem $P(A|B) = \frac{P(B|A)P(A)}{P(B)}$ underlies classification in diagnosis and machine learning.

## Expectation, variance and spread

For a discrete random variable, the expectation is $E[X] = \sum_x x P(X = x)$ while the variance is $\mathrm{Var}(X) = E[(X - E[X])^2]$ and the standard deviation is the square root $\sigma = \sqrt{\mathrm{Var}(X)}$ of that variance. Chebyshev's inequality $P(|X - \mu| \ge k\sigma) \le \frac{1}{k^2}$ shows how the variance controls how tightly observations cluster near the mean. A fair six-sided die gives any single face with probability $\frac{1}{6}$ for each face.

## Common probability distributions

Different situations call for different distributions, and choosing the right model is the starting point of statistical analysis.

| Distribution | Setting | Main parameters |
| --- | --- | --- |
| Binomial | Successes in $n$ independent trials | $n$ trials, success probability $p$ |
| Poisson | Sparse events in a fixed interval | Expected count $\lambda$ |
| Exponential | Waiting times and equipment lifetime | Mean wait $\lambda^{-1}$ |
| Normal | Sample means and measurement error | Mean $\mu$ with standard deviation $\sigma$ |

For the normal distribution the familiar 68–95–99.7 rule applies: about $68$ %, $95$ % and $99.7$ % of observations fall within one, two and three standard deviations of the mean, which makes rough judgements possible without computing every value.

## Independence and the use of conditionals

Events $A$ and $B$ are independent when $P(A \cap B) = P(A)P(B)$ so learning about one leaves the probability of the other untouched. Many real phenomena are not independent, since rainfall and rain volume correlate strongly, which is exactly why Bayesian classifiers estimate a class from the joint probability of features. The union bound gives $P(A) \ge 1 - \frac{1}{N}$ whenever $N$ independent events each occur with probability at least $p$ each.

## Related articles

- [Statistical inference](#/p/inference)
- [Data analysis](#/p/data-analysis)
- [Algebra](#/p/algebra)
- [Geometry](#/p/geometry)
- [Mathematical analysis](#/p/math-analysis)
- [Matter](#/p/matter)
