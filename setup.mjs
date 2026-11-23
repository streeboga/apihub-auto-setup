#!/usr/bin/env node
import { run } from './src/setup.mjs';

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(`APIHub Auto: ${error.message}`);
  process.exitCode = 1;
}
