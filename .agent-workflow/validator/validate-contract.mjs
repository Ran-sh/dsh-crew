#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';

const STATUSES = new Set(['PASS', 'FAIL', 'PARTIAL', 'SKIP', 'BLOCKED', 'NOT RUN']);
const MODES = new Set(['IMPLEMENT', 'TEST_ONLY', 'REVIEW_ONLY']);
const TASK_KEYS = new Set([
  'id', 'mode', 'source_branch', 'source_commit', 'objective', 'context',
  'allowed_changes', 'forbidden_changes', 'validation', 'acceptance_criteria',
  'result_contract', 'completion_commit_contract', 'delete_active_task_on_completion', 'metadata'
]);
const RESULT_KEYS = new Set([
  'task_id', 'source_commit', 'result_commit', 'status', 'summary',
  'changed_files', 'tests', 'blockers', 'result_path', 'notes'
]);
const TEST_KEYS = new Set(['name', 'status', 'evidence']);
const ACTIVE_TASK_JSON = 'docs/agent-tasks/ACTIVE_TASK.json';
const ACTIVE_TASK_MD = 'docs/agent-tasks/ACTIVE_TASK.md';

function fail(message) {
  console.error(`INVALID: ${message}`);
  process.exitCode = 1;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPrimitive(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function validateString(value, name, errors, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') errors.push(`${name} must be a string`);
  else if (!allowEmpty && value.length === 0) errors.push(`${name} must not be empty`);
}

function validateStringArray(value, name, errors, { min = 0 } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${name} must be an array`);
    return;
  }
  if (value.length < min) errors.push(`${name} must contain at least ${min} item(s)`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.length === 0) errors.push(`${name}[${index}] must be a non-empty string`);
  }
  if (new Set(value).size !== value.length) errors.push(`${name} must not contain duplicates`);
}

function validateTask(value) {
  const errors = [];
  if (!isObject(value)) return ['task must be an object'];

  for (const key of unknownKeys(value, TASK_KEYS)) errors.push(`unknown task property: ${key}`);

  validateString(value.id, 'id', errors);
  validateString(value.mode, 'mode', errors);
  if (typeof value.mode === 'string' && !MODES.has(value.mode)) errors.push(`invalid mode: ${value.mode}`);
  validateString(value.source_branch, 'source_branch', errors);
  validateString(value.source_commit, 'source_commit', errors);
  validateString(value.objective, 'objective', errors);
  validateString(value.context, 'context', errors, { allowEmpty: true });
  validateStringArray(value.allowed_changes, 'allowed_changes', errors);
  validateStringArray(value.forbidden_changes, 'forbidden_changes', errors, { min: 1 });
  validateStringArray(value.validation, 'validation', errors, { min: 1 });
  validateStringArray(value.acceptance_criteria, 'acceptance_criteria', errors, { min: 1 });
  validateString(value.result_contract, 'result_contract', errors);
  validateStringArray(value.completion_commit_contract, 'completion_commit_contract', errors);

  if (typeof value.result_contract === 'string' && !/^docs\/agent-results\//.test(value.result_contract)) {
    errors.push(`result_contract must be under docs/agent-results/**: ${value.result_contract}`);
  }

  if (Array.isArray(value.allowed_changes) && typeof value.result_contract === 'string' && !value.allowed_changes.includes(value.result_contract)) {
    errors.push('allowed_changes must include result_contract');
  }

  if (Array.isArray(value.completion_commit_contract) && typeof value.result_contract === 'string') {
    if (!value.completion_commit_contract.includes(value.result_contract)) {
      errors.push('completion_commit_contract must include result_contract');
    }
    if (!value.completion_commit_contract.includes(ACTIVE_TASK_JSON)) {
      errors.push(`completion_commit_contract must include ${ACTIVE_TASK_JSON}`);
    }
  }

  if (value.delete_active_task_on_completion !== true) errors.push('delete_active_task_on_completion must be true');

  if (value.metadata !== undefined) {
    if (!isObject(value.metadata)) errors.push('metadata must be an object');
    else {
      for (const [key, item] of Object.entries(value.metadata)) {
        if (!isPrimitive(item)) errors.push(`metadata.${key} must be string, number, boolean, or null`);
      }
      if (value.metadata.companion === true && Array.isArray(value.completion_commit_contract) && !value.completion_commit_contract.includes(ACTIVE_TASK_MD)) {
        errors.push(`metadata.companion=true requires ${ACTIVE_TASK_MD} in completion_commit_contract`);
      }
    }
  }

  if (value.mode === 'TEST_ONLY' || value.mode === 'REVIEW_ONLY') {
    for (const item of value.allowed_changes ?? []) {
      if (typeof item === 'string' && !/^docs\/agent-results\//.test(item)) {
        errors.push(`${value.mode} allowed_changes may only include docs/agent-results/**: ${item}`);
      }
    }
    for (const item of value.completion_commit_contract ?? []) {
      if (typeof item === 'string' && !/^docs\/agent-results\//.test(item) && item !== ACTIVE_TASK_JSON && item !== ACTIVE_TASK_MD) {
        errors.push(`${value.mode} completion_commit_contract may only include result paths and ACTIVE task deletion: ${item}`);
      }
    }
  }

  return errors;
}

function validateResult(value) {
  const errors = [];
  if (!isObject(value)) return ['result must be an object'];

  for (const key of unknownKeys(value, RESULT_KEYS)) errors.push(`unknown result property: ${key}`);

  validateString(value.task_id, 'task_id', errors);
  validateString(value.source_commit, 'source_commit', errors);
  if (value.result_commit !== undefined && value.result_commit !== null) validateString(value.result_commit, 'result_commit', errors);
  validateString(value.status, 'status', errors);
  if (typeof value.status === 'string' && !STATUSES.has(value.status)) errors.push(`invalid status: ${value.status}`);
  if (value.summary !== undefined) validateString(value.summary, 'summary', errors, { allowEmpty: true });
  validateStringArray(value.changed_files, 'changed_files', errors);
  validateStringArray(value.blockers, 'blockers', errors);
  validateString(value.result_path, 'result_path', errors);
  if (typeof value.result_path === 'string' && !/^docs\/agent-results\//.test(value.result_path)) {
    errors.push(`result_path must be under docs/agent-results/**: ${value.result_path}`);
  }
  if (value.notes !== undefined) validateStringArray(value.notes, 'notes', errors);

  if (!Array.isArray(value.tests)) errors.push('tests must be an array');
  else {
    for (const [index, test] of value.tests.entries()) {
      if (!isObject(test)) {
        errors.push(`tests[${index}] must be an object`);
        continue;
      }
      for (const key of unknownKeys(test, TEST_KEYS)) errors.push(`tests[${index}]: unknown property: ${key}`);
      validateString(test.name, `tests[${index}].name`, errors);
      validateString(test.status, `tests[${index}].status`, errors);
      if (typeof test.status === 'string' && !STATUSES.has(test.status)) errors.push(`tests[${index}]: invalid status: ${test.status}`);
      if (test.evidence !== undefined) validateString(test.evidence, `tests[${index}].evidence`, errors, { allowEmpty: true });
    }
  }

  if (value.status === 'BLOCKED' && Array.isArray(value.blockers) && value.blockers.length === 0) {
    errors.push('BLOCKED result must include at least one blocker');
  }
  if (value.status === 'PASS' && Array.isArray(value.tests) && value.tests.some((test) => !isObject(test) || test.status !== 'PASS')) {
    errors.push('PASS result cannot contain non-PASS test states');
  }

  return errors;
}

async function main() {
  const [kind, path] = process.argv.slice(2);
  if (!['task', 'result'].includes(kind) || !path) {
    console.error('Usage: node validator/validate-contract.mjs <task|result> <path-to-json>');
    process.exit(2);
  }

  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail(`cannot read/parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const errors = kind === 'task' ? validateTask(value) : validateResult(value);
  if (errors.length > 0) {
    for (const error of errors) fail(error);
    return;
  }

  console.log(`VALID ${kind.toUpperCase()} CONTRACT: ${path}`);
}

await main();
