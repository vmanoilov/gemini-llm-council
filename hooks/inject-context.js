/**
 * inject-context.js: BeforeTool hook for gemini-llm-council
 */

const fs = require('node:fs');
const path = require('node:path');

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf-8'));
  const { toolName, args } = input;

  // Only target council tools that take a context argument
  if (toolName !== 'council__consult' && toolName !== 'council__init_session') {
    process.exit(0);
  }

  let projectMetadata = '';

  // Try to find project manifest or README.md for grounding
  const rootFiles = ['package.json', 'GEMINI.md', 'README.md', 'go.mod', 'Cargo.toml'];
  for (const file of rootFiles) {
    if (fs.existsSync(file)) {
      try {
        let content;
        if (file === 'package.json') {
          // Smart Slicing: Only extract dependencies and metadata
          const pkg = JSON.parse(fs.readFileSync(file, 'utf-8'));
          content = JSON.stringify({
            name: pkg.name,
            version: pkg.version,
            description: pkg.description,
            dependencies: pkg.dependencies,
            devDependencies: pkg.devDependencies
          }, null, 2);
        } else {
          // Fallback to first 100 lines for other files
          content = fs.readFileSync(file, 'utf-8').split('\n').slice(0, 100).join('\n');
        }
        projectMetadata += `
--- [Metadata from ${file}] ---
${content}
`;
      } catch (e) {
        // Ignore read errors
      }
    }
  }

  if (projectMetadata) {
    const updatedArgs = { ...args };
    updatedArgs.context = `${projectMetadata}

=== USER PROVIDED CONTEXT ===
${args.context || 'No specific context provided.'}`;
    
    console.log(JSON.stringify({
      args: updatedArgs,
      systemMessage: `🏛️  **Council**: Automatically injected project metadata from workspace roots.`
    }));
  }
}

main();
