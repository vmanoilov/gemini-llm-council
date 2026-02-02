const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '../package.json');
const extPath = path.join(__dirname, '../gemini-extension.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const ext = JSON.parse(fs.readFileSync(extPath, 'utf8'));

if (ext.version !== pkg.version) {
  ext.version = pkg.version;
  fs.writeFileSync(extPath, JSON.stringify(ext, null, 2) + '\n');
  console.log(`Synced gemini-extension.json version to ${pkg.version}`);
} else {
  console.log(`gemini-extension.json is already at version ${pkg.version}`);
}
