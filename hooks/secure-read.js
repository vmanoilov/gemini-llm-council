/**
 * secure-read.js: BeforeTool hook for gemini-llm-council
 * Enforces strict security boundaries for the council_investigator subagent.
 */

const fs = require('node:fs');
const path = require('node:path');

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf-8'));
  const { toolName, args, agentName } = input;

  // We only strictly police the autonomous investigator subagent
  if (agentName !== 'council_investigator') {
    process.exit(0);
  }

  if (toolName === 'read_file') {
    const filePath = args.file_path;
    if (!filePath) process.exit(0);

    const normalizedPath = path.normalize(filePath);
    const fileName = path.basename(normalizedPath);

    // 1. Denylist: Sensitive file names and noise-reduction folders
    const SENSITIVE_FILES = [
      '.env', 'id_rsa', 'id_ed25519', 'credentials.json', 'config.json',
      '.git/config', '.npmrc', '.ssh/', 'node_modules/'
    ];
    if (SENSITIVE_FILES.some(f => normalizedPath.toLowerCase().includes(f.toLowerCase()))) {
      console.log(JSON.stringify({
        block: true,
        reason: `🔒 **Security Block**: The autonomous investigator is not allowed to read sensitive files or dependency noise (${fileName}).`
      }));
      process.exit(0);
    }

    // 2. Boundary Check: Outside project root
    // CLI provides GEMINI_PROJECT_ROOT environment variable
    const projectRoot = process.env.GEMINI_PROJECT_ROOT;
    if (projectRoot) {
      let resolvedPath;
      try {
        // Symlink Protection: Resolve the actual physical disk path
        resolvedPath = fs.realpathSync(filePath);
      } catch (e) {
        // Fallback if file doesn't exist yet
        resolvedPath = path.resolve(filePath);
      }

      const absoluteRoot = path.resolve(projectRoot);
      if (!resolvedPath.startsWith(absoluteRoot)) {
        console.log(JSON.stringify({
          block: true,
          reason: `🔒 **Security Block**: The autonomous investigator is restricted to the project workspace and cannot read external files.`
        }));
        process.exit(0);
      }
    }
  }
}

main();
