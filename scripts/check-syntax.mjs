import { spawnSync } from 'node:child_process'

const files = [
  'scripts/build-client.mjs',
  'scripts/check-syntax.mjs',
  'index.js',
  'client.js',
  'src/identity-core.js',
  'src/identity-client.js',
  'src/identity-host.js',
  'src/identity-patch.js',
  'src/model-catalog.js',
  'src/model-groups.js',
  'src/model-storage.js',
  'src/model-selector.js',
  'src/workspace-flat-toggle.js',
  'src/settings-panel.js',
  'src/styles.js',
  'src/i18n.js',
  'src/features.js',
  'test/helpers.js',
  'test/model-catalog.test.js',
  'test/model-groups.test.js',
  'test/model-storage.test.js',
  'test/model-selector.test.js',
  'test/workspace-flat-toggle.test.js',
  'test/settings-panel.test.js',
  'test/settings-interaction.test.js',
  'test/settings-tabs.test.js',
  'test/identity-core.test.js',
  'test/identity-patch.test.js',
  'test/identity-host.test.js',
  'test/identity-client.test.js',
  'test/identity-entry.test.js',
  'test/client-bundle.test.js',
]

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log(`syntax OK (${files.length} files)`)
