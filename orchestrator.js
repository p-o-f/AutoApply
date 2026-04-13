require("dotenv").config();
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const axios = require("axios"); // Add axios: npm install axios
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");

// --- Directories ---
const logsDir = path.join(__dirname, "logs");
const errorsDir = path.join(__dirname, "logs", "errors");
const authSessionsDir = path.join(__dirname, "auth_sessions");
[logsDir, errorsDir, authSessionsDir].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

class Logger {
  constructor(filePath) {
    this.filePath = filePath;
  }
  log(message, type = "info") {
    const timestamp = new Date().toISOString();
    const icon =
      { error: "❌", action: "🛠️", think: "🧠", info: "ℹ️", success: "✅" }[
        type
      ] || "ℹ️";
    const logEntry = `\n**[${timestamp}]** ${icon} \n\`\`\`\n${message}\n\`\`\`\n`;
    fs.appendFileSync(this.filePath, logEntry);
    console.log(`[${type.toUpperCase()}] ${message}`);
  }
  error(err) {
    this.log(err.stack || err.message, "error");
  }
}

const logger = new Logger(path.join(__dirname, "audit_log.md"));

// --- The Brain: Ollama Connector ---
async function askOllama(prompt) {
  try {
    const response = await axios.post("http://127.0.0.1:11434/api/generate", {
      model: "qwen3:14b",
      prompt: prompt,
      stream: false
    });
    return response.data.response; // RETURN RAW STRING SO WE CAN AUDIT IT
  } catch (err) {
    logger.error(new Error(`Ollama connection failed: ${err.message}`));
    return null;
  }
}

async function askForUserIntervention(promptText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  process.stdout.write("\x07");
  return new Promise((resolve) => {
    rl.question(
      `\n⚠️ GATEKEEPER: ${promptText}\nPress Enter to continue...`,
      () => {
        rl.close();
        resolve();
      },
    );
  });
}

async function main() {
  logger.log("Autoapply: Launching 48h Sprint Engine...");

  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", "@playwright/mcp"],
  });

  const client = new Client(
    { name: "Autoapply", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    logger.log("MCP Connected. Establishing Persistent Session...", "success");

    // 1. Launch Browser with your auth_sessions folder
    await client.callTool({
      name: "playwright_launch",
      arguments: {
        headless: false,
        userDataDir: authSessionsDir, // CRITICAL: This saves your 2FA
      },
    });

    // 2. The Heartbeat (Prevent Apple/Workday timeouts)
    setInterval(
      async () => {
        logger.log("Heartbeat: Pinging session...", "info");
        try {
          await client.callTool({
            name: "playwright_mouse_wheel",
            arguments: { deltaY: 100 },
          });
        } catch (e) {
          logger.log("Heartbeat missed.", "error");
        }
      },
      8 * 60 * 1000,
    );

    // Load Jobs & Recipe
    const pendingJobs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pending_jobs.json'), 'utf8'));
    const appleRecipe = fs.readFileSync(path.join(__dirname, 'recipes', 'apple_recipe.md'), 'utf8');

    for (let targetUrl of pendingJobs) {
      logger.log(`Processing Job Queue Search URL: ${targetUrl}`, "action");

      await client.callTool({
        name: "browser_navigate",
        arguments: { url: targetUrl },
      });

      // Allow search page to load
      await new Promise(resolve => setTimeout(resolve, 4000));

      logger.log(`Scraping individual Job details links...`, "info");
      const scrapeRes = await client.callTool({
         name: "browser_evaluate",
         arguments: { function: `() => { return JSON.stringify(Array.from(new Set(Array.from(document.querySelectorAll('a')).map(a => a.href).filter(h => h && h.includes('/en-us/details/'))))); }` }
      });
      
      let jobUrls = [];
      try {
           let dirtyText = scrapeRes.content[0].text;
           
           // Clean out any Markdown wrapper if it exists
           if (dirtyText.includes('### Result')) {
               dirtyText = dirtyText.split('### Result')[1].split('###')[0].trim();
           }
           
           // Check if it's double-stringified (escaped)
           if (dirtyText.startsWith('"') && dirtyText.endsWith('"')) {
               dirtyText = JSON.parse(dirtyText);
           }
           
           jobUrls = JSON.parse(dirtyText); 
      } catch(e) {
           logger.error(new Error(`Failed to parse scraped URLs: ${scrapeRes.content[0]?.text}`));
      }

      logger.log(`Successfully extracted ${jobUrls.length} Apple Jobs from page!`, "success");

      // Loop through each physical job listing
      for (const singleJobUrl of jobUrls) {
          logger.log(`\n\n--- NAVIGATING TO INDIVIDUAL JOB: ${singleJobUrl} ---`, "action");
          await client.callTool({
            name: "browser_navigate",
            arguments: { url: singleJobUrl },
          });
          await new Promise(resolve => setTimeout(resolve, 3000));

          let jobComplete = false;
          let loopCounter = 0;
          let lastAction = null;

          // 4. THE AGENTIC LOOP (Per Job)
          while (!jobComplete && loopCounter < 20) {
        loopCounter++;
        logger.log(`--- [Loop ${loopCounter}] SENSE phase ---`, "info");

        // Sense: Fetch accessibility tree via browser_snapshot
        let treeRes;
        try {
          treeRes = await client.callTool({
            name: "browser_snapshot",
            arguments: {},
          });
        } catch (e) {
             logger.log("Snapshot failed. Falling back to evaluate.", "warning");
             treeRes = await client.callTool({
               name: "browser_evaluate",
               arguments: { script: `Array.from(document.querySelectorAll('button, a, input, select')).map(el => el.tagName + ' ' + (el.innerText || el.value || '')).join('\\n')` },
             });
        }

        const treeText = treeRes.content && treeRes.content.length > 0 ? treeRes.content[0].text : "";

        // Gatekeeper Check
        if (treeText.includes("Sign In") || treeText.includes("Log In")) {
          await askForUserIntervention("Manual Login Required. Handle 2FA in the browser window.");
          logger.log("Gatekeeper passed. Resuming Loop.", "success");
          continue; // Re-evaluate DOM after user signs in
        }

        // Think: Ask Qwen
        logger.log("Passing state to Qwen3...", "think");
        const prompt = `You are an autonomous application agent. Respond ONLY in valid JSON. No conversational text.
Allowed tools: 'browser_click', 'browser_fill_form', 'success'.
For 'browser_click', output: {"tool": "browser_click", "arguments": {"ref": "the_ref_from_tree"}}
For 'browser_fill_form', output: {"tool": "browser_fill_form", "arguments": {"ref": "...", "value": "..."}}
For 'success', output: {"tool": "success"}

RECIPE:
${appleRecipe}

CURRENT DOM:
${treeText.substring(0, 15000)} // Context limit safety

PREVIOUS AUTOMATED ACTION TAKEN:
${lastAction ? JSON.stringify(lastAction) : "None (This is the first step)"}

If the DOM did not change after the previous action, you must try a DIFFERENT tool or reference.
OUTPUT STRICT JSON:`;

        const rawQwenResponse = await askOllama(prompt);

        if (!rawQwenResponse) {
            logger.log("Ollama returned empty response. Retrying...", "error");
            continue;
        }

        let qwenDecision;
        try {
            // Robustly strip Markdown blocks and isolate the JSON object
            let cleanStr = rawQwenResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
            const startIdx = cleanStr.indexOf('{');
            const endIdx = cleanStr.lastIndexOf('}');
            if (startIdx !== -1 && endIdx !== -1) {
                 cleanStr = cleanStr.substring(startIdx, endIdx + 1);
            }
            qwenDecision = JSON.parse(cleanStr);
        } catch (e) {
            logger.log(`FATAL JSON PARSE ERROR. Raw output was:\n${rawQwenResponse}`, "error");
            continue;
        }

        if (!qwenDecision.tool) {
            logger.log(`Raw JSON was valid, but missing 'tool' key! Raw Output:\n${rawQwenResponse}`, "error");
            continue;
        }

        logger.log(`Qwen determined action: ${JSON.stringify(qwenDecision)}`, "action");

        // Act: Execute the Tool or Trigger Success
        if (qwenDecision.tool === "success") {
          logger.log("SUCCESS DETECTED! Writing to audit log...", "success");
          
          await client.callTool({
             name: "browser_take_screenshot",
             arguments: { name: "victory_shot" }
          }).then(res => {
             // Basic attempt to save base64 shot if returned by MCP into /logs/success/
             if (res.content && res.content[0] && res.content[0].text) {
                 fs.writeFileSync(path.join(__dirname, 'logs', 'success', `success_${Date.now()}.png`), res.content[0].text, 'base64');
             }
          }).catch(e => logger.error(new Error("Victory screenshot failed")));
          
          jobComplete = true; // Breaks while loop, proceeds to next targetUrl
        } else {
            // Apply standard MCP tool
            try {
              await client.callTool({
                 name: qwenDecision.tool,
                 arguments: qwenDecision.arguments || {}
              });
              lastAction = qwenDecision; // Log action into history
              // Wait for UI to react
              await new Promise(resolve => setTimeout(resolve, 3000));
            } catch(e) {
                logger.error(new Error(`Tool execution failed: ${e.message}`));
                lastAction = { failed_attempt: qwenDecision, error: e.message };
            }
        }
      } // end while loop
      
      logger.log(`Finished processing specific job: ${singleJobUrl}`, "success");
    } // end jobs array

    logger.log(`Finished processing entire search page: ${targetUrl}`, "success");
    
    // Auto-paginate to page 2 and wait
    if (targetUrl.includes('page=1')) {
        const nextPageUrl = targetUrl.replace('page=1', 'page=2');
        logger.log(`Force paginating to Page 2 (${nextPageUrl}) and dropping into Wait State...`, "info");
        await client.callTool({
          name: "browser_navigate",
          arguments: { url: nextPageUrl },
        });
    }

  }

  logger.log("Queue complete! Hanging script to preserve session...", "info");
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

main();
