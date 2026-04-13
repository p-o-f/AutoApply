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
      stream: false,
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
  logger.log("Autoapply: Launching Engine...");

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
    const pendingJobs = JSON.parse(
      fs.readFileSync(path.join(__dirname, "pending_jobs.json"), "utf8"),
    );
    const appleRecipe = fs.readFileSync(
      path.join(__dirname, "recipes", "apple_recipe.md"),
      "utf8",
    );

    for (let targetUrl of pendingJobs) {
      logger.log(`Processing Job Queue Search URL: ${targetUrl}`, "action");

      await client.callTool({
        name: "browser_navigate",
        arguments: { url: targetUrl },
      });

      // Allow search page to load
      await new Promise((resolve) => setTimeout(resolve, 4000));

      logger.log(`Scraping individual Job details links...`, "info");
      const scrapeRes = await client.callTool({
        name: "browser_evaluate",
        arguments: {
          function: `() => {
            const results = [];
            const applied = [];
            // Find all job links on the search results page
            const links = Array.from(document.querySelectorAll('a[href*="/en-us/details/"]'));
            const seen = new Set();
            for (const link of links) {
              const href = link.href;
              if (seen.has(href)) continue;
              seen.add(href);
              // Walk up to the job listing row (usually a few levels up)
              let row = link.closest('tr, li, [role="row"], [class*="table-row"], [class*="result"]') || link.parentElement?.parentElement?.parentElement;
              // Check if this row has an "applied" indicator (green checkmark)
              let isApplied = false;
              if (row) {
                // Look for any element with applied/submitted text in aria-label, title, or text content
                const indicators = row.querySelectorAll('svg, img, [aria-label], [title]');
                for (const el of indicators) {
                  const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
                  if (label.includes('applied') || label.includes('submitted')) {
                    isApplied = true;
                    break;
                  }
                }
                // Also check for any text node containing "applied"
                if (!isApplied && row.textContent.toLowerCase().includes("you've applied")) {
                  isApplied = true;
                }
              }
              if (isApplied) {
                applied.push(href);
              } else {
                results.push(href);
              }
            }
            return JSON.stringify({ fresh: results, alreadyApplied: applied.length });
          }`,
        },
      });

      let jobUrls = [];
      try {
        let dirtyText = scrapeRes.content[0].text;

        // Clean out any Markdown wrapper if it exists
        if (dirtyText.includes("### Result")) {
          dirtyText = dirtyText.split("### Result")[1].split("###")[0].trim();
        }

        // Check if it's double-stringified (escaped)
        if (dirtyText.startsWith('"') && dirtyText.endsWith('"')) {
          dirtyText = JSON.parse(dirtyText);
        }

        const parsed = JSON.parse(dirtyText);
        if (parsed.fresh) {
          jobUrls = parsed.fresh;
          logger.log(`Skipped ${parsed.alreadyApplied} already-applied jobs (green checkmark)`, "info");
        } else {
          // Fallback if it returned a plain array
          jobUrls = Array.isArray(parsed) ? parsed : [];
        }
      } catch (e) {
        logger.error(
          new Error(
            `Failed to parse scraped URLs: ${scrapeRes.content[0]?.text}`,
          ),
        );
      }

      // Filter: LLM decides if each job is engineering-adjacent
      const beforeCount = jobUrls.length;
      const filteredUrls = [];
      for (const url of jobUrls) {
        // Extract human-readable title from URL slug
        const slug = url.split('/').pop()?.split('?')[0]?.replace(/-/g, ' ') || '';
        const filterPrompt = `Is this job title an engineering or technical role (software, hardware, data science, ML, DevOps, architecture, etc)? Title: "${slug}". Reply ONLY with YES or NO.`;
        const verdict = await askOllama(filterPrompt);
        const isEng = verdict && verdict.trim().toUpperCase().includes('YES');
        if (isEng) {
          filteredUrls.push(url);
        } else {
          logger.log(`Filtered out non-engineering role: "${slug}"`, "info");
        }
      }
      jobUrls = filteredUrls;
      logger.log(`LLM filtered ${beforeCount} → ${jobUrls.length} engineering roles (skipped ${beforeCount - jobUrls.length} non-engineering)`, "info");

      logger.log(
        `Successfully extracted ${jobUrls.length} engineering jobs from page!`,
        "success",
      );

      // Loop through each physical job listing
      for (const singleJobUrl of jobUrls) {
        logger.log(
          `\n\n--- NAVIGATING TO INDIVIDUAL JOB: ${singleJobUrl} ---`,
          "action",
        );
        await client.callTool({
          name: "browser_navigate",
          arguments: { url: singleJobUrl },
        });
        await new Promise((resolve) => setTimeout(resolve, 3000));

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
              arguments: {
                script: `Array.from(document.querySelectorAll('button, a, input, select')).map(el => el.tagName + ' ' + (el.innerText || el.value || '')).join('\\n')`,
              },
            });
          }

          const rawTreeText =
            treeRes.content && treeRes.content.length > 0
              ? treeRes.content[0].text
              : "";

          // Strip the massive Apple Footer — it's 60%+ of the tree and confuses the LLM
          const footerIdx = rawTreeText.indexOf('contentinfo "Apple Footer"');
          const treeText = footerIdx !== -1 ? rawTreeText.substring(0, footerIdx) : rawTreeText;

          // Gatekeeper Check
          if (treeText.includes("Sign In") || treeText.includes("Log In")) {
            await askForUserIntervention(
              "Manual Login Required. Handle 2FA in the browser window.",
            );
            logger.log("Gatekeeper passed. Resuming Loop.", "success");
            continue; // Re-evaluate DOM after user signs in
          }

          // Think: Ask Qwen
          logger.log("Passing state to Qwen3...", "think");
          const prompt = `You are an autonomous application agent.

CURRENT URL:
${singleJobUrl}

RECIPE:
${appleRecipe}

CURRENT DOM:
${treeText}`;

          // DEBUG: Dump what Qwen actually sees
          fs.writeFileSync(path.join(__dirname, 'logs', 'last_tree_dump.txt'), treeText);
          logger.log(`Tree loaded: ${treeText.length} chars`, "info");

          const promptSuffix = `

PREVIOUS AUTOMATED ACTION TAKEN:
${lastAction ? JSON.stringify(lastAction) : "None (This is the first step)"}

If the DOM did not change after the previous action, you must try a DIFFERENT tool or reference.

FIRST: Examine the CURRENT URL. If the URL does not look like a real job details page (e.g. it contains 'locationPicker', 'search', 'login', or other non-application paths), immediately output a 'skip' action. Only proceed with the recipe if the URL is a legitimate job posting page.

CRITICAL INSTRUCTIONS:
Respond ONLY in valid JSON. No conversational text.
You MUST include your internal 'thought' process in the JSON.
IMPORTANT: When selecting a ref ID, carefully verify the ref belongs to the EXACT element you intend to interact with. Read the text label next to each ref in the DOM tree. Do NOT pick a neighboring ref by mistake.

Allowed tools: 'browser_click', 'browser_fill_form', 'browser_navigate', 'success', 'skip'.
- browser_click: Click an element. Output: {"thought": "your reasoning", "tool": "browser_click", "arguments": {"ref": "the_ref_from_tree"}}
- browser_fill_form: Type into a text field. Output: {"thought": "your reasoning", "tool": "browser_fill_form", "arguments": {"ref": "...", "value": "..."}}
- browser_navigate: Navigate to a URL. Use this if you accidentally clicked the wrong link and need to go back. Output: {"thought": "your reasoning", "tool": "browser_navigate", "arguments": {"url": "..."}}
- success: ONLY use this when you see a confirmation message like 'Thank you', 'Application submitted', or 'Application received' on screen. Do NOT use this just because you are stuck or confused. Output: {"thought": "your reasoning", "tool": "success"}
- skip: Use this if you are stuck, confused, or cannot find the right element to proceed. This will skip to the next job. Output: {"thought": "your reasoning", "tool": "skip"}

OUTPUT STRICT JSON:`;

          const rawQwenResponse = await askOllama(prompt + promptSuffix);

          if (!rawQwenResponse) {
            logger.log("Ollama returned empty response. Retrying...", "error");
            continue;
          }

          let qwenDecision;
          try {
            // Robustly strip Markdown blocks and isolate the JSON object
            let cleanStr = rawQwenResponse
              .replace(/```json/gi, "")
              .replace(/```/g, "")
              .trim();
            const startIdx = cleanStr.indexOf("{");
            const endIdx = cleanStr.lastIndexOf("}");
            if (startIdx !== -1 && endIdx !== -1) {
              cleanStr = cleanStr.substring(startIdx, endIdx + 1);
            }
            qwenDecision = JSON.parse(cleanStr);
          } catch (e) {
            logger.log(
              `FATAL JSON PARSE ERROR. Raw output was:\n${rawQwenResponse}`,
              "error",
            );
            continue;
          }

          if (!qwenDecision.tool) {
            logger.log(
              `Raw JSON was valid, but missing 'tool' key! Raw Output:\n${rawQwenResponse}`,
              "error",
            );
            continue;
          }
          if (qwenDecision.thought) {
            logger.log(`Qwen's Thought: ${qwenDecision.thought}`, "info");
          }
          logger.log(
            `Qwen determined action: {"tool":"${qwenDecision.tool}","arguments":${JSON.stringify(qwenDecision.arguments || {})}}`,
            "action",
          );

          // Act: Execute the Tool or Trigger Success
          if (qwenDecision.tool === "success") {
            logger.log("SUCCESS DETECTED! Writing to audit log...", "success");

            const successDir = path.join(__dirname, "logs", "success");
            if (!fs.existsSync(successDir)) fs.mkdirSync(successDir, { recursive: true });

            await client
              .callTool({
                name: "browser_take_screenshot",
                arguments: { name: "victory_shot" },
              })
              .then((res) => {
                if (res.content && res.content[0]) {
                  // MCP returns screenshots as base64 in .data (image type) or .text (text type)
                  const b64 = res.content[0].data || res.content[0].text;
                  if (b64) {
                    fs.writeFileSync(
                      path.join(successDir, `success_${Date.now()}.png`),
                      Buffer.from(b64, "base64"),
                    );
                    logger.log("Victory screenshot saved!", "success");
                  } else {
                    logger.log("Screenshot response had no image data", "error");
                  }
                }
              })
              .catch((e) =>
                logger.error(new Error(`Victory screenshot failed: ${e.message}`)),
              );

            jobComplete = true; // Breaks while loop, proceeds to next targetUrl
          } else if (qwenDecision.tool === "skip") {
            logger.log(`SKIPPING JOB — Qwen is stuck. Reason: ${qwenDecision.thought || "No reason given"}`, "action");
            jobComplete = true; // Break loop, move to next job
          } else {
            // Apply standard MCP tool
            try {
              await client.callTool({
                name: qwenDecision.tool,
                arguments: qwenDecision.arguments || {},
              });
              lastAction = qwenDecision; // Log action into history
              // Wait for UI to react
              await new Promise((resolve) => setTimeout(resolve, 3000));
            } catch (e) {
              logger.error(new Error(`Tool execution failed: ${e.message}`));
              lastAction = { failed_attempt: qwenDecision, error: e.message };
            }
          }
        } // end while loop

        logger.log(
          `Finished processing specific job: ${singleJobUrl}`,
          "success",
        );
      } // end jobs array

      logger.log(
        `Finished processing entire search page: ${targetUrl}`,
        "success",
      );

      // Auto-paginate to page 2 and wait
      if (targetUrl.includes("page=1")) {
        const nextPageUrl = targetUrl.replace("page=1", "page=2");
        logger.log(
          `Force paginating to Page 2 (${nextPageUrl}) and dropping into Wait State...`,
          "info",
        );
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
