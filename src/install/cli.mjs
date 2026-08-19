#!/usr/bin/env node
// Usage: node src/install/cli.mjs <claude|codex|all|hud|uninstall-claude|uninstall-codex|uninstall-all> [--statusline] [--project]

import { installClaudeCode, installCodex, uninstallClaudeCode, uninstallCodex, installHudSegment } from './install.mjs';

const cmd = process.argv[2];
const flags = new Set(process.argv.slice(3));
const opts = { statusline: flags.has('--statusline'), scope: flags.has('--project') ? 'project' : 'user' };

const run = {
  claude: () => [installClaudeCode(opts)],
  codex: () => [installCodex(opts)],
  all: () => [installClaudeCode(opts), installHudSegment(opts), installCodex(opts)],
  'uninstall-claude': () => [uninstallClaudeCode(opts)],
  'uninstall-codex': () => [uninstallCodex(opts)],
  'uninstall-all': () => [uninstallClaudeCode(opts), uninstallCodex(opts)],
  hud: () => [installHudSegment(opts)],
}[cmd];

if (!run) {
  console.error('usage: cli.mjs <claude|codex|all|hud|uninstall-claude|uninstall-codex|uninstall-all> [--statusline] [--project]');
  process.exit(1);
}
for (const p of run()) {
  const r = await p;
  for (const a of r.actions) console.log('•', a);
}
console.log('done.');
