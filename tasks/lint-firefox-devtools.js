import { spawnSync } from 'node:child_process'

const result = spawnSync(
  process.execPath,
  [
    'node_modules/web-ext/bin/web-ext.js',
    'lint',
    '--source-dir',
    'extensions/build/firefox',
    '--output',
    'json',
    '--self-hosted',
  ],
  { encoding: 'utf8' },
)

if (result.error) throw result.error
if (!result.stdout) {
  throw new Error(`Firefox validator failed${result.stderr ? `: ${result.stderr}` : ''}`)
}

const report = JSON.parse(result.stdout)
const unexpectedWarnings = report.warnings.filter(
  warning => warning.code !== 'UNSAFE_VAR_ASSIGNMENT' || warning.file !== 'panel.js',
)

if (report.errors.length > 0 || unexpectedWarnings.length > 0) {
  console.error(
    JSON.stringify(
      { errors: report.errors, notices: report.notices, warnings: unexpectedWarnings },
      null,
      2,
    ),
  )
  process.exitCode = 1
} else {
  console.log(
    `Firefox validation passed with ${report.warnings.length} expected React runtime warnings`,
  )
}
