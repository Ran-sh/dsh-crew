# Agent Results

Durable Result Contracts and reports live here. Machine-readable results should identify source commit, work performed, exact validations, PASS/FAIL/PARTIAL/SKIP/BLOCKED/NOT RUN states, evidence, changed files, blockers, result path, limitations, and result commit when available.

Validate JSON results with:

```sh
node .agent-workflow/validator/validate-contract.mjs result <result-json>
```

Do not include private chain-of-thought, credentials, tokens, or signed URLs. Existing historical Markdown reports remain valid evidence; new machine-driven tasks should prefer JSON Result Contracts.
