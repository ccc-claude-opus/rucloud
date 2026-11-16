> Filed under: [Natural Sciences](#/p/cat-li) › [Statistics and data analysis](#/p/cat-statistics)

## Overview

**Data analysis** is the process of examining, organising and interpreting data in order to reach conclusions, combining statistical methods with tools to support decisions. It spans description, cleaning, exploration and modelling, with reproducibility and verifiability as key criteria.

## The analysis workflow and data types

A complete analysis usually proceeds by defining the problem, collecting data, cleaning it, exploring, modelling and communicating findings. Along the way the analyst must identify data types: categorical variables such as education level, numeric variables such as annual income, time series such as monthly sales and geographic data such as postal codes. Misclassifying a variable leads directly to the wrong statistical method being chosen later.

## Descriptive statistics

Descriptive statistics summarise central tendency and spread with a few indicators.

| Indicator | Formula | When to use |
| --- | --- | --- |
| Mean | $\bar x = \frac{1}{n}\sum_{i=1}^{n} x_i$ | Roughly symmetric distributions |
| Median | Middle value after ordering | Skewed data or outliers |
| Mode | Most frequent value | Categorical data |
| Standard deviation | $s = \sqrt{\frac{\sum (x_i - \bar x)^2}{n-1}}$ | Measuring spread |
| Interquartile range | $Q_3 - Q_1$ | Robust spread measure |

For strongly right-skewed data such as income or house prices, the median and quartiles describe a typical case better than the mean: mean US household income is around $80{,}000$ while the median is near $48{,}000$ a year.

## Exploration and visualisation

Graphics are the most efficient exploratory tools. A histogram shows the shape of a distribution, a box plot summarises spread and outliers through the five-number summary made up of the minimum, the quartiles $Q_1$ and $Q_3$ plus the median and the maximum while a scatter plot reveals associations between two numeric variables. Chart choice should follow the data type: histograms for continuous data, bar charts for categories and line charts for time series, with axis scales never distorted to exaggerate differences.

## Correlation, causation and data quality

The Pearson correlation $r$ runs from $-1$ to $1$ and measures the strength of a linear association between numeric variables, but correlation is not causation: confounders, reverse causality and sampling bias can all manufacture spurious relationships. Practical work must also address missing values, outliers, duplicate records and inconsistent units. Documenting each cleaning step in code or a data log is what makes the analysis reproducible and auditable.

## Related articles

- [Probability](#/p/probability)
- [Statistical inference](#/p/inference)
- [Algebra](#/p/algebra)
- [Geometry](#/p/geometry)
- [Mathematical analysis](#/p/math-analysis)
- [Matter](#/p/matter)
