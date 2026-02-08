#!/usr/bin/env node

/**
 * Post-install script for clawdbot-smart-context
 * 
 * This script:
 * 1. Checks if Clawdbot is installed
 * 2. Applies patches to Clawdbot core (hooks.js, attempt.js)
 * 3. Initializes database schema
 * 4. Verifies installation
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Colors for terminal output
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function findClawdbot() {
  // Try common installation paths
  const possiblePaths = [
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'clawdbot'),
    '/usr/local/lib/node_modules/clawdbot',
    '/opt/homebrew/lib/node_modules/clawdbot',
    process.env.CLAWDBOT_DIR
  ].filter(Boolean);

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Try using npm to find it
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const clawdbotPath = path.join(npmRoot, 'clawdbot');
    if (fs.existsSync(clawdbotPath)) {
      return clawdbotPath;
    }
  } catch (err) {
    // Ignore
  }

  return null;
}

function applyPatches(clawdbotDir) {
  log('\n📦 Applying Clawdbot patches...', 'blue');

  const scriptDir = __dirname;
  const applyScript = path.join(scriptDir, 'apply-patches.sh');

  if (!fs.existsSync(applyScript)) {
    log('⚠️  apply-patches.sh not found, skipping patch application', 'yellow');
    log('   You may need to apply patches manually after installation', 'yellow');
    return false;
  }

  try {
    // Make script executable
    fs.chmodSync(applyScript, 0o755);

    // Run apply-patches.sh with CLAWDBOT_DIR
    execSync(`CLAWDBOT_DIR="${clawdbotDir}" "${applyScript}"`, {
      stdio: 'inherit',
      env: { ...process.env, CLAWDBOT_DIR: clawdbotDir }
    });

    log('✅ Patches applied successfully', 'green');
    return true;
  } catch (err) {
    log('❌ Failed to apply patches', 'red');
    log('   Run manually: npm run apply-patches', 'yellow');
    return false;
  }
}

function initializeDatabase() {
  log('\n💾 Initializing database schema...', 'blue');

  const dbPath = path.join(os.homedir(), '.clawdbot', 'smart-context-cache.db');
  const dbDir = path.dirname(dbPath);

  // Create .clawdbot directory if it doesn't exist
  if (!fs.existsSync(dbDir)) {
    try {
      fs.mkdirSync(dbDir, { recursive: true });
      log(`✅ Created directory: ${dbDir}`, 'green');
    } catch (err) {
      log(`⚠️  Could not create ${dbDir}: ${err.message}`, 'yellow');
      return false;
    }
  }

  // Database will be initialized on first use by the plugin
  log('✅ Database will be initialized on first use', 'green');
  return true;
}

function verifyInstallation(clawdbotDir) {
  log('\n🔍 Verifying installation...', 'blue');

  const scriptDir = __dirname;
  const checkScript = path.join(scriptDir, 'check-patches.sh');

  if (!fs.existsSync(checkScript)) {
    log('⚠️  check-patches.sh not found, skipping verification', 'yellow');
    return true; // Don't fail installation
  }

  try {
    // Make script executable
    fs.chmodSync(checkScript, 0o755);

    // Run check-patches.sh
    execSync(`CLAWDBOT_DIR="${clawdbotDir}" "${checkScript}"`, {
      stdio: 'inherit',
      env: { ...process.env, CLAWDBOT_DIR: clawdbotDir }
    });

    log('✅ Installation verified', 'green');
    return true;
  } catch (err) {
    log('⚠️  Verification incomplete (patches may need manual application)', 'yellow');
    return true; // Don't fail installation
  }
}

function printNextSteps() {
  log('\n📋 Next Steps:', 'blue');
  log('   1. Add plugin to ~/.clawdbot/clawdbot.json:', 'reset');
  log('      {', 'reset');
  log('        "plugins": {', 'reset');
  log('          "load": { "packages": ["clawdbot-smart-context"] },', 'reset');
  log('          "entries": {', 'reset');
  log('            "smart-context": { "enabled": true, "config": {...} }', 'reset');
  log('          }', 'reset');
  log('        }', 'reset');
  log('      }', 'reset');
  log('', 'reset');
  log('   2. Restart Clawdbot:', 'reset');
  log('      clawdbot gateway restart', 'reset');
  log('', 'reset');
  log('   3. Verify plugin is loaded:', 'reset');
  log('      clawdbot plugins list', 'reset');
  log('', 'reset');
  log('   4. Test memory system:', 'reset');
  log('      node $(npm root -g)/clawdbot-smart-context/test-memory.js', 'reset');
  log('', 'reset');
  log('   See INSTALLATION.md for detailed setup instructions.', 'reset');
}

// Main installation flow
async function main() {
  log('╔════════════════════════════════════════╗', 'blue');
  log('║  Smart Context Post-Install Setup     ║', 'blue');
  log('╚════════════════════════════════════════╝', 'blue');

  // 1. Find Clawdbot
  log('\n🔍 Locating Clawdbot installation...', 'blue');
  const clawdbotDir = findClawdbot();

  if (!clawdbotDir) {
    log('⚠️  Clawdbot installation not found', 'yellow');
    log('   Patches will need to be applied manually after Clawdbot is installed.', 'yellow');
    log('   Set CLAWDBOT_DIR environment variable or install Clawdbot first.', 'yellow');
    printNextSteps();
    return; // Don't fail npm install
  }

  log(`✅ Found Clawdbot at: ${clawdbotDir}`, 'green');

  // 2. Apply patches
  const patchesApplied = applyPatches(clawdbotDir);

  // 3. Initialize database
  const dbInitialized = initializeDatabase();

  // 4. Verify installation
  const verified = verifyInstallation(clawdbotDir);

  // 5. Summary
  log('\n' + '═'.repeat(50), 'blue');
  if (patchesApplied && dbInitialized && verified) {
    log('✅ Installation complete!', 'green');
  } else if (patchesApplied) {
    log('⚠️  Installation complete with warnings', 'yellow');
    log('   Some steps may need manual completion', 'yellow');
  } else {
    log('⚠️  Post-install steps incomplete', 'yellow');
    log('   Patches need to be applied manually:', 'yellow');
    log('   npm run apply-patches', 'yellow');
  }
  log('═'.repeat(50), 'blue');

  printNextSteps();
}

// Run if executed directly (not required)
if (require.main === module) {
  main().catch(err => {
    log(`\n❌ Post-install error: ${err.message}`, 'red');
    // Don't exit with error code - we don't want to break npm install
    process.exit(0);
  });
}

module.exports = { main };
