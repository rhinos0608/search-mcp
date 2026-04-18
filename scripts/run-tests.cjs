const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

const flagsWithSeparateValues = new Set([
  '--test-concurrency',
  '--test-name-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-shard',
  '--watch-path',
]);

function mapTestTarget(arg, outDir) {
  if (!arg.startsWith('test/')) {
    return arg;
  }

  return path.join(outDir, arg).replace(/\.ts$/u, '.js');
}

function buildNodeTestArgs(args, outDir) {
  const forwarded = ['--test'];
  let hasExplicitTarget = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('-')) {
      forwarded.push(arg);

      if (flagsWithSeparateValues.has(arg) && index + 1 < args.length) {
        index += 1;
        forwarded.push(args[index]);
      }

      continue;
    }

    forwarded.push(mapTestTarget(arg, outDir));
    hasExplicitTarget = true;
  }

  if (!hasExplicitTarget) {
    forwarded.push(path.join(outDir, 'test', '**', '*.test.js'));
  }

  return forwarded;
}

function run(command, args) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function main(args) {
  const tempRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  const outDir = path.join(tempRoot, 'dist');
  let exitCode = 0;

  try {
    const compileResult = run(process.execPath, [
      tscBin,
      '-p',
      'tsconfig.test.json',
      '--outDir',
      outDir,
      '--pretty',
      'false',
    ]);

    if (compileResult.status !== 0) {
      exitCode = compileResult.status ?? 1;
    } else {
      const testResult = run(process.execPath, buildNodeTestArgs(args, outDir));
      exitCode = testResult.status ?? 1;
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  return exitCode;
}

module.exports = {
  buildNodeTestArgs,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
