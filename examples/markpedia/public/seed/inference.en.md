> Filed under: [Natural Sciences](#/p/cat-li) › [Statistics and data analysis](#/p/cat-statistics)

## Overview

**Statistical inference** draws conclusions about a population from sample data using probability models. It is the bridge between data and claims, covering point estimation, interval estimation, hypothesis testing and regression modelling.

## Sampling and sampling distributions

Inference starts with sampling: $n$ observations drawn at random from the population. The central limit theorem states that the sampling distribution of the sample mean $\bar X$ is approximately normal even when the population is not, with accuracy improving as $n$ grows; the usual standardised form is $Z = \frac{\bar X - \mu}{\sigma/\sqrt n}$ for large samples. Proportions behave similarly, with a standard error for the estimated proportion $\hat p$ of about $\sqrt{p(1-p)/n}$ for each estimate.

## Point and interval estimation

A point estimate summarises a population parameter with a single number, such as the sample mean $\bar X$ for the population mean $\mu$ while an interval estimate gives a range. With the population standard deviation $\sigma$ known, a $95$ % confidence interval takes the approximate form $\bar X \pm 1.96 \frac{\sigma}{\sqrt n}$ and when $\sigma$ is unknown and $n$ is small, the $t$ distribution with $n - 1$ degrees of freedom is used. The confidence level is the long-run proportion of such intervals that cover the parameter.

## Hypothesis testing

A test starts from a null hypothesis $H_0$ and computes the p value, the probability of results at least as extreme as those observed, assuming $H_0$ holds. If the p value falls below a pre-set significance level, commonly $0.05$ in most fields, the null is rejected. Two error types must be distinguished: a type I error rejects a true null, and a type II error fails to reject a false one; statistical power equals $1 - \beta$ where $\beta$ is the type II error rate.

## Regression and model evaluation

Regression estimates relationships between variables and supports prediction, most often by ordinary least squares, with slope $\hat \beta_1 = \frac{\sum (x_i - \bar x)(y_i - \bar y)}{\sum (x_i - \bar x)^2}$ and intercept $\hat \beta_0 = \bar y - \hat \beta_1 \bar x$ in each case. The coefficient of determination $R^2$ gives the share of variance in the response explained by the predictor, but a high $R^2$ alone does not establish causation. The main ingredients of inference are listed below.

| Quantity | Meaning | Common value or form |
| --- | --- | --- |
| p value | Probability of results at least as extreme, given $H_0$ | Significance level usually $0.05$ |
| Confidence level | Share of repeated intervals that cover the parameter | $95$ % is most common |
| Power | Probability of correctly rejecting a false $H_0$ | Written as $1 - \beta$ |
| $R^2$ | Share of response variance explained by the predictor | Lies between $0$ and $1$ |

## Related articles

- [Probability](#/p/probability)
- [Data analysis](#/p/data-analysis)
- [Algebra](#/p/algebra)
- [Geometry](#/p/geometry)
- [Mathematical analysis](#/p/math-analysis)
- [Matter](#/p/matter)
