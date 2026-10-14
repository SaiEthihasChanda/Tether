#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv).catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
