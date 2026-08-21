# Agent Results

New Result Contracts use **schema_version 2**.

Historical Result Contracts without `schema_version` are treated as legacy v1 and remain valid for audit/readback. Do not rewrite old reports just to add v2 fields. Existing historical Markdown reports in this repository also remain valid evidence.

Result Contract v2 must contain:

- source commit
- overall status
- exact validation commands and evidence
- changed files and blockers
- result path / result commit when available
- a second-precision execution timeline with timezone
- validator-owned Result Contract evidence

## Timeline

Use ISO 8601 timestamps with **year, month, day, hour, minute, second, and timezone**. Milliseconds are intentionally omitted.

Example:

```text
2026-08-21T15:12:04+08:00
```

Required v2 timeline:

```json
"schema_version": 2,
"timeline": {
  "started_at": "2026-08-21T15:12:04+08:00",
  "completed_at": "2026-08-21T15:13:41+08:00"
}
```

`completed_at` must not be earlier than `started_at`.

## Result validator evidence

Do not manually claim that the Result Contract validated successfully.

After all execution evidence is written and `timeline.completed_at` is final, run the installed validator with `--stamp`:

```bash
node .agent-workflow/validator/validate-contract.mjs result <result-json> --stamp
```

`--stamp` upgrades/stamps the draft as Result Contract v2 and, on success, the validator itself writes `result_validation`, including:

- `status: PASS`
- the validator command
- `validated_at` to the second with timezone
- validator success evidence

A new v2 Result Contract without stamped `result_validation` is incomplete and normal result validation rejects it.

The intended v2 timeline is:

```text
started_at
   ↓
local work / tests
   ↓
completed_at
   ↓
validator --stamp
   ↓
result_validation.validated_at
```

Legacy v1 Result Contracts remain accepted without these new fields so historical evidence is not broken by workflow upgrades.

Do not include private chain-of-thought, secrets, credentials, private local paths, or sensitive environment values.
