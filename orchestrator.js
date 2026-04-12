require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// Ensure directories exist
const logsDir = path.join(__dirname, 'logs');
const errorsDir = path.join(__dirname, 'logs', 'errors');
const authSessionsDir = path.join(__dirname, 'auth_sessions');
[logsDir, errorsDir, authSessionsDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

class Logger {
    constructor(filePath) {
        this.filePath = filePath;
    }
    
    log(message, type = 'info') {
        const timestamp = new Date().toISOString();
        const icon = type === 'error' ? '❌' : type === 'action' ? '🛠️' : type === 'think' ? '🧠' : 'ℹ️';
        const logEntry = `\n**[${timestamp}]** ${icon} \n\`\`\`\n${message}\n\`\`\`\n`;
        fs.appendFileSync(this.filePath, logEntry);
        console.log(`[${type.toUpperCase()}] ${message}`);
    }

    error(err) {
        this.log(err.stack || err.message, 'error');
    }
}

const logger = new Logger(path.join(__dirname, 'audit_log.md'));

// The Gatekeeper Helper
async function askForUserIntervention(promptText) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('\x07'); // Emit audible chime
    return new Promise(resolve => {
        rl.question(`\n⚠️ GATEKEEPER PAUSE: ${promptText}\nPress Enter to continue once resolved...`, () => {
            rl.close();
            resolve();
        });
    });
}

async function main() {
    logger.log('Starting Project Nexus Orchestrator...');

    // Establish MCP connection to a locally spawned Playwright MCP server
    logger.log('Initializing Playwright MCP Server...', 'action');
    
    const transport = new StdioClientTransport({
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['-y', '@modelcontextprotocol/server-playwright']
    });

    const client = new Client({
        name: 'NexusOrchestrator',
        version: '1.0.0'
    }, {
        capabilities: {}
    });

    try {
        await client.connect(transport);
        logger.log('Connected to Playwright MCP Server');

        // Example: Auth Check - Navigate to target URL
        const targetUrl = 'https://news.ycombinator.com/login'; // Example target
        logger.log(`Navigating to Target URL: ${targetUrl}`, 'action');
        
        await client.callTool({
            name: 'playwright_navigate',
            arguments: { url: targetUrl }
        });

        logger.log('Waiting for gatekeeper condition...', 'think');
        
        // We simulate a check for a "Sign In" selector #login or similar
        // We'll pause execution, ring chime, and wait for human input.
        logger.log('Detected Gatekeeper condition. Action required.', 'action');
        await askForUserIntervention('Please complete the sign-in/2FA manual step in the newly spawned browser.');

        logger.log('User intervention completed. Resuming autonomous Agentic Loop...', 'info');

        // Close session
        await transport.close();
        logger.log('Process complete. Shutting down.', 'info');
        process.exit(0);

    } catch (err) {
        logger.error(err);
        
        try {
            // Attempt to take an error screenshot via MCP
            logger.log('Attempting to take error screenshot...', 'action');
            await client.callTool({
                name: 'playwright_screenshot',
                arguments: { name: 'error_state', _file: path.join(errorsDir, `error_${Date.now()}.png`) } // note: exact parameters depend on the official server, we just pass standard ones.
            });
            logger.log('Screenshot command sent to MCP.', 'info');
        } catch (ssErr) {
            logger.error(new Error('Failed to capture error screenshot: ' + ssErr.message));
        }

        await askForUserIntervention('Encountered an error. Check logs/errors. Press Enter when ready to exit.');
        process.exit(1);
    }
}

main().catch(err => {
    logger.error(err);
    process.exit(1);
});
