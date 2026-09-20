#!/usr/bin/env node
import { runCli } from './cli.js';
import { PACKAGE_NAME } from './version.js';

// A closed pipe (`india-subscriptions openapi | head`) is not an error worth a stack trace.
const BROKEN_PIPE = 'EPIPE';
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== BROKEN_PIPE) throw error;
});

runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  handleSignals: true,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${PACKAGE_NAME}: unexpected failure: ${error instanceof Error ? error.name : 'unknown'}\n`);
    process.exitCode = 1;
  },
);
