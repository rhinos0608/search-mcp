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

/** Recursively collect .test.js files under dir. */
function findTestFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTestFiles(full));
    } else if (entry.name.endsWith('.test.js')) {
      results.push(full);
    }
  }
  return results;
}

function buildNodeTestArgs(args, outDir) {
  const forwarded = [
    '--import',
    path.join(outDir, 'test', 'setup.js'),
    '--test',
  ];
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
    // Resolve test files explicitly — avoids relying on Node's --test glob
    // expansion which varies across versions.
    const testDir = path.join(outDir, 'test');
    const testFiles = findTestFiles(testDir).sort();
    if (testFiles.length === 0) {
      console.error('ERROR: No .test.js files found in', testDir);
    }
    forwarded.push(...testFiles);
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
    // Symlink models directory
    const modelsSource = path.join(repoRoot, 'models');
    const modelsTarget = path.join(outDir, 'models');
    fs.mkdirSync(outDir, { recursive: true });
    if (fs.existsSync(modelsSource)) {
       fs.symlinkSync(modelsSource, modelsTarget);
    }

    // Copy package.json so version.ts can read it via ../package.json
    // Note: with rootDir=".", version.ts compiles to dist/src/version.js,
    // so ../package.json resolves to dist/package.json.
    const pkgSrc = path.join(repoRoot, 'package.json');
    const pkgDst = path.join(outDir, 'package.json');
    if (fs.existsSync(pkgSrc)) {
      fs.copyFileSync(pkgSrc, pkgDst);
    }

    const compileResult = run(process.execPath, [
      tscBin,
      '-p',
      'tsconfig.test.json',
      '--outDir',
      outDir,
    ]);

    if (compileResult.status !== 0) {
      exitCode = compileResult.status ?? 1;
    } else {
      // Verify compiled test files exist before running tests
      const testDir = path.join(outDir, 'test');
      if (!fs.existsSync(testDir)) {
        console.error('ERROR: TypeScript compilation produced no test/ directory.');
        console.error('  Compiled output directory:', outDir);
        exitCode = 1;
      } else {
        const testResult = run(process.execPath, buildNodeTestArgs(args, outDir));
        exitCode = testResult.status ?? 1;
      }
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
