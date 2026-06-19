---
name: report-style-guide
description: Generate professional HTML data reports with charts, metrics dashboards, and insights. Use when creating analysis reports, data summaries, or presentations that combine text and visualizations.
---

# Report Style Guide

## Design Philosophy

- **Data clarity** - Present information in a clear, scannable format
- **Professional aesthetic** - Clean, minimal design with purposeful use of color
- **Consistent branding** - Match our product visual language (green palette, JetBrains Mono titles)
- **Self-contained** - Reports should be single HTML files that work offline

## When to Use This Skill

Use this skill when creating:
- Data analysis reports
- Executive summaries with metrics
- Research findings documents
- Any HTML document that combines narrative, metrics, and visualizations

## Report Structure

A well-structured report includes:

1. **Header** - Report type label, title, subtitle, date
2. **Executive Summary** - Key takeaways in callout box
3. **Metrics Dashboard** - 4-column grid of key figures
4. **Visualizations** - Charts/images with captions
5. **Data Tables** - Detailed breakdowns with highlight rows
6. **Key Insights** - Numbered findings or rankings
7. **Conclusion** - Summary and recommendations
8. **Footer** - Copyright and branding

## Typography

- **Titles/Headers**: JetBrains Mono (via Google Fonts)
- **Body text**: System fonts (-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)

## Color Palette

```css
/* Primary brand color */
--primary-green: #1a6642;

/* Semantic colors */
--positive: #1a6642;  /* Green for positive values/growth */
--negative: #dc3545;  /* Red for negative values/decline */

/* Neutral */
--text-primary: #2d2d2d;
--text-secondary: #666666;
--border: #e8e8e8;
--background-subtle: #f8f9fa;
```

## Key Components

### Metrics Card
```html
<div class="metric-card">
    <div class="metric-value positive">+15.2%</div>
    <div class="metric-label">Growth Rate</div>
    <div class="metric-change positive">+2.3% vs prior</div>
</div>
```

### Callout Box
```html
<div class="callout">
    <p><strong>Key Finding:</strong> Important insight or summary here.</p>
</div>
```

### Data Table
```html
<table class="data-table">
    <thead>
        <tr><th>Column 1</th><th class="text-right">Value</th></tr>
    </thead>
    <tbody>
        <tr><td>Data</td><td class="text-right mono">1,234</td></tr>
        <tr class="highlight"><td><strong>Top Item</strong></td><td class="text-right mono">5,678</td></tr>
    </tbody>
</table>
```

### Numbered Rankings
```html
<ol class="rankings">
    <li><strong>Item Name</strong> - Description with <span class="value">1,234</span> units</li>
</ol>
```

### Chart Container
```html
<figure class="chart-container">
    <img src="data:image/png;base64,..." alt="Description of chart">
    <figcaption>Figure 1: Chart title and brief explanation</figcaption>
</figure>
```

### Insights Grid
```html
<div class="insights-grid">
    <div class="insight-card">
        <h4>Insight Title</h4>
        <p>Description of the insight.</p>
    </div>
</div>
```

## Embedding Charts

When including charts generated with the `chart-style-guide` skill, embed them as base64:

```python
import base64

# After saving chart
with open('/home/user/chart.png', 'rb') as f:
    chart_base64 = base64.b64encode(f.read()).decode('utf-8')

# Use in HTML
# <img src="data:image/png;base64,{chart_base64}" alt="...">
```

## Print/PDF Optimization

The template includes `@media print` styles for clean PDF output:
- Page breaks before major sections
- Optimized margins and spacing

## Branding

- Company: Sidekick
- Footer: "&copy; 2025 Sidekick. All rights reserved."

---

## Full HTML Template

Use this complete template as the base for all reports. Copy and customize the sections you need:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Data Report - Sidekick</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --primary-green: #1a6642;
            --primary-green-light: #2d8659;
            --positive: #1a6642;
            --negative: #dc3545;
            --text-primary: #2d2d2d;
            --text-secondary: #666666;
            --text-muted: #888888;
            --border: #e8e8e8;
            --background-subtle: #f8f9fa;
            --white: #ffffff;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            font-size: 14px;
            line-height: 1.6;
            color: var(--text-primary);
            background: var(--white);
            max-width: 1000px;
            margin: 0 auto;
            padding: 40px 24px;
        }

        /* Typography */
        h1, h2, h3, h4 {
            font-family: 'JetBrains Mono', monospace;
            font-weight: 600;
            line-height: 1.3;
        }

        h1 {
            font-size: 28px;
            color: var(--text-primary);
            margin-bottom: 8px;
        }

        h2 {
            font-size: 20px;
            color: var(--text-primary);
            margin: 32px 0 16px 0;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--border);
        }

        h3 {
            font-size: 16px;
            color: var(--text-primary);
            margin: 24px 0 12px 0;
        }

        p {
            margin-bottom: 16px;
            color: var(--text-primary);
        }

        /* Header */
        .report-header {
            margin-bottom: 32px;
            padding-bottom: 24px;
            border-bottom: 3px solid var(--primary-green);
        }

        .report-type {
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: var(--primary-green);
            margin-bottom: 8px;
        }

        .report-subtitle {
            font-size: 16px;
            color: var(--text-secondary);
            margin-bottom: 4px;
        }

        .report-date {
            font-size: 13px;
            color: var(--text-muted);
        }

        /* Metrics Dashboard */
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 16px;
            margin: 24px 0;
        }

        .metric-card {
            background: var(--background-subtle);
            border-radius: 8px;
            padding: 20px;
            text-align: center;
        }

        .metric-value {
            font-family: 'JetBrains Mono', monospace;
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 4px;
        }

        .metric-value.positive { color: var(--positive); }
        .metric-value.negative { color: var(--negative); }
        .metric-value.neutral { color: var(--text-primary); }

        .metric-label {
            font-size: 12px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .metric-change {
            font-size: 11px;
            margin-top: 4px;
        }

        .metric-change.positive { color: var(--positive); }
        .metric-change.negative { color: var(--negative); }

        /* Callout Box */
        .callout {
            background: var(--background-subtle);
            border-left: 4px solid var(--primary-green);
            padding: 16px 20px;
            margin: 24px 0;
            border-radius: 0 8px 8px 0;
        }

        .callout strong { color: var(--primary-green); }
        .callout p:last-child { margin-bottom: 0; }

        /* Charts and Images */
        .chart-container {
            margin: 24px 0;
            text-align: center;
        }

        .chart-container img {
            max-width: 100%;
            height: auto;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
        }

        .chart-container figcaption {
            font-size: 12px;
            color: var(--text-secondary);
            margin-top: 12px;
            font-style: italic;
        }

        /* Data Tables */
        .data-table {
            width: 100%;
            border-collapse: collapse;
            margin: 24px 0;
            font-size: 13px;
        }

        .data-table th {
            font-family: 'JetBrains Mono', monospace;
            font-weight: 600;
            text-align: left;
            padding: 12px 16px;
            background: var(--background-subtle);
            border-bottom: 2px solid var(--border);
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-secondary);
        }

        .data-table td {
            padding: 12px 16px;
            border-bottom: 1px solid var(--border);
        }

        .data-table tbody tr:hover { background: var(--background-subtle); }
        .data-table tr.highlight { background: rgba(26, 102, 66, 0.08); }
        .data-table tr.highlight:hover { background: rgba(26, 102, 66, 0.12); }
        .data-table .text-right { text-align: right; }
        .data-table .text-center { text-align: center; }

        /* Rankings List */
        .rankings {
            list-style: none;
            counter-reset: ranking;
            margin: 24px 0;
        }

        .rankings li {
            counter-increment: ranking;
            padding: 16px 20px 16px 60px;
            position: relative;
            border-bottom: 1px solid var(--border);
        }

        .rankings li:last-child { border-bottom: none; }

        .rankings li::before {
            content: counter(ranking);
            position: absolute;
            left: 16px;
            top: 50%;
            transform: translateY(-50%);
            width: 28px;
            height: 28px;
            background: var(--primary-green);
            color: var(--white);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: 'JetBrains Mono', monospace;
            font-weight: 600;
            font-size: 12px;
        }

        .rankings li strong { color: var(--text-primary); }
        .rankings .value {
            font-family: 'JetBrains Mono', monospace;
            font-weight: 600;
            color: var(--primary-green);
        }

        /* Insights Grid */
        .insights-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 16px;
            margin: 24px 0;
        }

        .insight-card {
            background: var(--background-subtle);
            border-radius: 8px;
            padding: 20px;
        }

        .insight-card h4 {
            font-size: 14px;
            margin-bottom: 8px;
            color: var(--primary-green);
        }

        .insight-card p {
            font-size: 13px;
            color: var(--text-secondary);
            margin-bottom: 0;
        }

        /* Footer */
        .report-footer {
            margin-top: 48px;
            padding-top: 24px;
            border-top: 1px solid var(--border);
            text-align: center;
        }

        .report-footer p {
            font-size: 12px;
            color: var(--text-muted);
            margin-bottom: 0;
        }

        /* Utility Classes */
        .positive { color: var(--positive); }
        .negative { color: var(--negative); }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .text-muted { color: var(--text-muted); }
        .mb-0 { margin-bottom: 0; }

        /* Responsive */
        @media (max-width: 768px) {
            body { padding: 24px 16px; }
            h1 { font-size: 24px; }
            .metrics-grid { grid-template-columns: repeat(2, 1fr); }
            .insights-grid { grid-template-columns: 1fr; }
            .rankings li { padding-left: 50px; }
        }

        /* Print Styles */
        @media print {
            body { max-width: none; padding: 0; font-size: 11pt; }
            .report-header { page-break-after: avoid; }
            h2 { page-break-after: avoid; }
            .metrics-grid, .insights-grid, .chart-container, .callout { page-break-inside: avoid; }
            .data-table { page-break-inside: auto; }
            .data-table tr { page-break-inside: avoid; }
            .report-footer { page-break-before: avoid; }
        }
    </style>
</head>
<body>
    <!-- Report Header -->
    <header class="report-header">
        <div class="report-type">Data Analysis Report</div>
        <h1>Report Title Goes Here</h1>
        <p class="report-subtitle">Subtitle or description of the report scope</p>
        <p class="report-date">Generated: January 15, 2025</p>
    </header>

    <!-- Executive Summary -->
    <section>
        <h2>Executive Summary</h2>
        <div class="callout">
            <p><strong>Key Finding:</strong> Summarize the most important insight here.</p>
        </div>
        <p>Brief overview of the analysis, methodology, and scope.</p>
    </section>

    <!-- Metrics Dashboard -->
    <section>
        <h2>Key Metrics</h2>
        <div class="metrics-grid">
            <div class="metric-card">
                <div class="metric-value positive">1,234</div>
                <div class="metric-label">Total Count</div>
                <div class="metric-change positive">+12.5% vs prior</div>
            </div>
            <div class="metric-card">
                <div class="metric-value negative">-8.3%</div>
                <div class="metric-label">Change Rate</div>
                <div class="metric-change negative">Down from -5.2%</div>
            </div>
            <div class="metric-card">
                <div class="metric-value neutral">$45.2K</div>
                <div class="metric-label">Average Value</div>
                <div class="metric-change positive">+3.1% vs prior</div>
            </div>
            <div class="metric-card">
                <div class="metric-value positive">94.7%</div>
                <div class="metric-label">Success Rate</div>
                <div class="metric-change positive">+2.3% improvement</div>
            </div>
        </div>
    </section>

    <!-- Visualization Section -->
    <section>
        <h2>Analysis</h2>
        <p>Description of the analysis methodology.</p>
        <figure class="chart-container">
            <img src="data:image/png;base64,..." alt="Chart description">
            <figcaption>Figure 1: Chart title and explanation</figcaption>
        </figure>
        <p>Interpretation of the chart and insights.</p>
    </section>

    <!-- Data Table Section -->
    <section>
        <h2>Detailed Breakdown</h2>
        <table class="data-table">
            <thead>
                <tr>
                    <th>Category</th>
                    <th>Description</th>
                    <th class="text-right">Value</th>
                    <th class="text-right">Change</th>
                </tr>
            </thead>
            <tbody>
                <tr class="highlight">
                    <td><strong>Top Item</strong></td>
                    <td>Description</td>
                    <td class="text-right mono">1,234</td>
                    <td class="text-right positive">+15.2%</td>
                </tr>
                <tr>
                    <td>Second Item</td>
                    <td>Description</td>
                    <td class="text-right mono">987</td>
                    <td class="text-right positive">+8.7%</td>
                </tr>
            </tbody>
        </table>
    </section>

    <!-- Rankings Section -->
    <section>
        <h2>Top Rankings</h2>
        <ol class="rankings">
            <li><strong>First Place</strong> - Description with <span class="value">1,234</span> units</li>
            <li><strong>Second Place</strong> - Description with <span class="value">987</span> units</li>
            <li><strong>Third Place</strong> - Description with <span class="value">654</span> units</li>
        </ol>
    </section>

    <!-- Insights Grid -->
    <section>
        <h2>Key Insights</h2>
        <div class="insights-grid">
            <div class="insight-card">
                <h4>Insight 1</h4>
                <p>Description of the first key insight.</p>
            </div>
            <div class="insight-card">
                <h4>Insight 2</h4>
                <p>Description of the second key insight.</p>
            </div>
        </div>
    </section>

    <!-- Conclusion -->
    <section>
        <h2>Conclusion</h2>
        <p>Summary of findings and implications.</p>
        <div class="callout">
            <p><strong>Recommendation:</strong> Based on this analysis, we recommend [action].</p>
        </div>
    </section>

    <!-- Footer -->
    <footer class="report-footer">
        <p>&copy; 2025 Sidekick. All rights reserved.</p>
    </footer>
</body>
</html>
```
