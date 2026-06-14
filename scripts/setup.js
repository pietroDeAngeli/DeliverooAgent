#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

function log(message) {
  console.log(`\x1b[36m${message}\x1b[0m`);
}

function success(message) {
  console.log(`\x1b[32m${message}\x1b[0m`);
}

function error(message) {
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
}

try {
  log('Setting up Deliveroo Agent...');

  // Initialize submodules
  log('Initializing git submodules...');
  execSync('git submodule update --init --recursive', { stdio: 'inherit' });

  // Check if Fast Downward exists
  const downwardPy = join('lib', 'downward', 'fast-downward.py');
  if (!existsSync(downwardPy)) {
    error('Fast Downward not found after submodule init');
  }

  // Check if already built
  const buildDir = join('lib', 'downward', 'builds', 'release', 'bin', 'translate');
  const translatePy = join('lib', 'downward', 'src-translate', 'translate.py');

  if (!existsSync(buildDir) && !existsSync(translatePy)) {
    log('Building Fast Downward...');
    const pythonCmd = process.env.PYTHON_CMD || 'python3';
    execSync(`${pythonCmd} build.py`, {
      cwd: 'lib/downward',
      stdio: 'inherit'
    });
    success('Fast Downward built successfully');
  } else {
    success('Fast Downward already built');
  }

  success('Setup complete!');
} catch (err) {
  error(`Setup failed: ${err.message}`);
}
