# Agent results

Durable reports from completed ACTIVE tasks live here when the task requires one.

Recommended naming:

```text
<agent>-<task>-report.md
<agent>-<task>-review.md
```

A report should be decision-oriented, not a transcript. Include source SHA, branch/environment when relevant, work/tests actually performed, results, evidence, blockers, known limitations, files changed, result commit SHA, and recommended next action.

For dsh-crew runtime validation, include workflow/attempt IDs, provider/model/selection source, relevant phase/status/error flags, and Git/test evidence when those facts are part of the requested scenario.

Never include secrets, credential contents, or private chain-of-thought.
