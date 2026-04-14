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
const cacheDir = path.join(__dirname, "cache");
[logsDir, errorsDir, authSessionsDir, cacheDir].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- Role Filter Cache (per-company, persistent across runs) ---
function getRoleCachePath(url) {
  try {
    const hostname = new URL(url).hostname.replace(/\./g, '_');
    return path.join(cacheDir, `role_cache_${hostname}.json`);
  } catch {
    return path.join(cacheDir, 'role_cache_unknown.json');
  }
}

function loadRoleCache(cachePath) {
  try {
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    }
  } catch (e) { /* corrupt cache, start fresh */ }
  return {}; // { url: "yes" | "no" }
}

function saveRoleCache(cachePath, cache) {
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

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
    const response = await axios({
      method: "post",
      url: "http://127.0.0.1:11434/api/generate",
      data: {
        model: "qwen3:14b",
        prompt: prompt,
        stream: true, // Enable streaming to see it typing live
      },
      responseType: "stream",
    });

    let fullResponse = "";
    process.stdout.write("\x1b[36m[QWEN] \x1b[0m"); // Cyan prefix

    return new Promise((resolve, reject) => {
      let buffer = "";
      response.data.on("data", (chunk) => {
        buffer += chunk.toString();
        // Ollama sends JSON lines. Process complete lines from the buffer.
        let lines = buffer.split("\n");
        buffer = lines.pop(); // keep the last incomplete chunk in the buffer

        for (const line of lines) {
          if (line.trim() === "") continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.response) {
              fullResponse += parsed.response;
              process.stdout.write("\x1b[32m" + parsed.response + "\x1b[0m"); // Print green text live
            }
          } catch (e) {
            // Ignore parse errors on partial chunks
          }
        }
      });

      response.data.on("end", () => {
        process.stdout.write("\n");
        resolve(fullResponse);
      });

      response.data.on("error", (err) => {
        logger.error(new Error(`Stream error: ${err.message}`));
        reject(err);
      });
    });
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
    args: [
      "-y", 
      "@playwright/mcp", 
      "--user-data-dir", 
      authSessionsDir,
      "--block-service-workers",
      "--blocked-origins", "*googlesyndication.com;*doubleclick.net;*analytics.google.com",
      "--console-level", "error"
    ],
  });

  const client = new Client(
    { name: "Autoapply", version: "1.0.0" },
    { capabilities: {} },
  );

  const sessionLog = {
    startTime: new Date().toLocaleString(),
    jobsAppliedTo: [],
    jobsSkipped: []
  };

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
    const userProfile = fs.readFileSync(
      path.join(__dirname, "profile.json"),
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

      // Global Gatekeeper: Verify Authentication before proceeding
      logger.log(`Verifying authentication state...`, "info");
      let signedIn = false;
      while (!signedIn) {
        const authCheck = await client.callTool({
          name: "browser_evaluate",
          arguments: {
            // Check for sign-in indicators (their PRESENCE means NOT logged in)
            // Also check for sign-out/profile indicators (their PRESENCE means logged in)
            function: `() => {
              const body = document.body.innerText;
              const hasSignIn = !!document.querySelector('a[href*="signin"]') 
                || !!document.querySelector('a[href*="sign-in"]')
                || !!document.querySelector('[data-id="sign-in"]')
                || body.includes("Sign in");
              const hasSignOut = !!document.querySelector('a[href*="signout"]')
                || !!document.querySelector('a[href*="sign-out"]')
                || !!document.querySelector('a[href*="logout"]')
                || body.includes("Sign Out")
                || body.includes("Sign out")
                || !!document.querySelector('.user-name, .profile-name, [data-analytics-title="my profile"]');
              return JSON.stringify({ hasSignIn, hasSignOut });
            }`
          }
        });

        try {
          let resultText = authCheck.content && authCheck.content[0] ? authCheck.content[0].text : "{}";
          // Strip Markdown wrappers (MCP wraps evaluate results in ### Result blocks)
          if (resultText.includes("### Result")) {
            resultText = resultText.split("### Result")[1].split("###")[0].trim();
          }
          if (resultText.includes("```")) {
            resultText = resultText.replace(/```json/gi, "").replace(/```/g, "").trim();
          }
          // Handle double-stringified JSON
          if (resultText.startsWith('"') && resultText.endsWith('"')) {
            resultText = JSON.parse(resultText);
          }
          const authState = JSON.parse(resultText);
          logger.log(`Auth state: hasSignIn=${authState.hasSignIn}, hasSignOut=${authState.hasSignOut}`, "info");

          if (authState.hasSignOut || !authState.hasSignIn) {
            signedIn = true;
            logger.log("Authentication confirmed. User is signed in.", "success");
          } else {
            await askForUserIntervention(
              "You are currently SIGNED OUT. Please click 'Sign In' in the browser, complete your 2FA, then press Enter."
            );
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        } catch (e) {
          logger.log(`Auth check parse error: ${e.message}. Assuming signed out.`, "error");
          await askForUserIntervention(
            "Could not verify auth state. Please ensure you are signed in, then press Enter."
          );
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

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
      let totalScrapedJobs = 0;
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
          totalScrapedJobs = parsed.fresh.length + (parsed.alreadyApplied || 0);
          logger.log(`Skipped ${parsed.alreadyApplied} already-applied jobs (green checkmark)`, "info");
        } else {
          // Fallback if it returned a plain array
          jobUrls = Array.isArray(parsed) ? parsed : [];
          totalScrapedJobs = jobUrls.length;
        }
      } catch (e) {
        logger.error(
          new Error(
            `Failed to parse scraped URLs: ${scrapeRes.content[0]?.text}`,
          ),
        );
      }

      // Filter: LLM decides if each job is engineering-adjacent (with persistent cache)
      const cachePath = getRoleCachePath(targetUrl);
      const roleCache = loadRoleCache(cachePath);
      const beforeCount = jobUrls.length;
      const filteredUrls = [];
      let cacheHits = 0;

      for (const url of jobUrls) {
        // Check cache first
        if (roleCache[url]) {
          if (roleCache[url] === 'yes') {
            filteredUrls.push(url);
          } else {
            const slug = url.split('/').pop()?.split('?')[0]?.replace(/-/g, ' ') || '';
            logger.log(`Filtered out (cached): "${slug}"`, "info");
          }
          cacheHits++;
          continue;
        }

        // Cache miss — ask the LLM
        const slug = url.split('/').pop()?.split('?')[0]?.replace(/-/g, ' ') || '';
        const filterPrompt = `Is this job title an engineering or technical role (software, hardware, data science, ML, DevOps, architecture, etc)? Title: "${slug}". Reply ONLY with YES or NO.`;
        const verdict = await askOllama(filterPrompt);
        const isEng = verdict && verdict.trim().toUpperCase().includes('YES');

        // Save to cache
        roleCache[url] = isEng ? 'yes' : 'no';

        if (isEng) {
          filteredUrls.push(url);
        } else {
          logger.log(`Filtered out non-engineering role: "${slug}"`, "info");
        }
      }

      // Persist cache to disk
      saveRoleCache(cachePath, roleCache);

      jobUrls = filteredUrls;
      logger.log(`LLM filtered ${beforeCount} → ${jobUrls.length} engineering roles (${cacheHits} cached, ${beforeCount - cacheHits} new LLM calls)`, "info");

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

          // --- DOM PRUNING (Role-Based Noise Reduction) ---
          // Strips entire subtrees of non-interactive semantic roles that bloat the tree.
          // Works on ANY site (Apple, Workday, Lever, Greenhouse) without hardcoded strings.
          const PRUNED_ROLES = ['navigation', 'contentinfo', 'banner', 'complementary'];

          function pruneAccessibilityTree(treeString) {
            const lines = treeString.split("\n");
            const result = [];
            let skipIndentLevel = -1;

            for (const line of lines) {
              const indentMatch = line.match(/^(\s*)/);
              const currentIndent = indentMatch ? indentMatch[0].length : 0;

              if (skipIndentLevel !== -1) {
                if (currentIndent > skipIndentLevel) {
                  continue; // Still inside a pruned subtree
                } else {
                  skipIndentLevel = -1; // Exited the pruned subtree
                }
              }

              // Check if the line starts a prunable role subtree
              const trimmed = line.trim();
              const isPrunedRole = PRUNED_ROLES.some(role =>
                trimmed.startsWith(`- ${role}`) || trimmed.startsWith(`${role} "`)
              );
              if (isPrunedRole) {
                skipIndentLevel = currentIndent;
                continue;
              }

              // Strip empty structural wrappers (no ref, no text = pure bloat)
              if (trimmed === '- generic:' || trimmed === '- generic' || trimmed === '- img:' || trimmed === '- img') {
                continue;
              }

              result.push(line);
            }
            return result.join("\n");
          }

          let treeText = pruneAccessibilityTree(rawTreeText);

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

APPLICANT PROFILE DATA & DIRECTIVES:
${userProfile}

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

Allowed tools: 'browser_click', 'browser_fill_form', 'browser_navigate', 'browser_upload_file', 'browser_select_option', 'success', 'skip'.
- browser_click: Click an element. Output: {"thought": "your reasoning", "tool": "browser_click", "arguments": {"ref": "the_ref_from_tree"}}
- browser_fill_form: Type into a text field. Output: {"thought": "your reasoning", "tool": "browser_fill_form", "arguments": {"ref": "...", "value": "..."}}
- browser_upload_file: Upload a file to a file input element. The 'filePath' should be a relative path from the project root (e.g. 'resumes/SWE.pdf'). Output: {"thought": "your reasoning", "tool": "browser_upload_file", "arguments": {"ref": "the_file_input_ref", "filePath": "resumes/SWE.pdf"}}
- browser_select_option: Select a dropdown option. Output: {"thought": "your reasoning", "tool": "browser_select_option", "arguments": {"ref": "...", "values": ["option_value"]}}
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
                name: "browser_screenshot",
                arguments: { fullPage: true },
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

            sessionLog.jobsAppliedTo.push({ url: singleJobUrl });
            jobComplete = true; // Breaks while loop, proceeds to next targetUrl
          } else if (qwenDecision.tool === "skip") {
            const reason = qwenDecision.thought || "No reason given";
            logger.log(`SKIPPING JOB — Qwen is stuck. Reason: ${reason}`, "action");
            sessionLog.jobsSkipped.push({ url: singleJobUrl, reason });
            jobComplete = true; // Break loop, move to next job
          } else if (qwenDecision.tool === "browser_upload_file") {
            // Custom file upload bridge — two-step to avoid dumping 230KB of base64 to terminal
            const filePath = path.resolve(__dirname, qwenDecision.arguments.filePath);
            const refId = qwenDecision.arguments.ref;

            if (!fs.existsSync(filePath)) {
              logger.log(`File not found: ${filePath}`, "error");
              lastAction = { failed_attempt: qwenDecision, error: `File not found: ${filePath}` };
            } else {
              const fileBuffer = fs.readFileSync(filePath);
              const base64Data = fileBuffer.toString("base64");
              const fileName = path.basename(filePath);
              const mimeType = fileName.endsWith(".pdf") ? "application/pdf" : "application/octet-stream";

              logger.log(`Uploading ${fileName} (${(fileBuffer.length / 1024).toFixed(1)} KB)...`, "action");

              try {
                // Step 1: Silently stash the base64 payload into a window global
                // (This avoids the MCP server logging 230KB of base64 to terminal)
                const chunkSize = 50000;
                const chunks = [];
                for (let i = 0; i < base64Data.length; i += chunkSize) {
                  chunks.push(base64Data.substring(i, i + chunkSize));
                }

                // Initialize the global
                await client.callTool({
                  name: "browser_evaluate",
                  arguments: { function: `() => { window.__uploadPayload = ""; return "init"; }` }
                });

                // Stream chunks into the global
                for (const chunk of chunks) {
                  await client.callTool({
                    name: "browser_evaluate",
                    arguments: { function: `() => { window.__uploadPayload += "${chunk}"; return "chunk"; }` }
                  });
                }

                // Step 2: Tiny function reads from global and attaches the file
                const uploadResult = await client.callTool({
                  name: "browser_evaluate",
                  arguments: {
                    function: `() => {
                      const base64Data = window.__uploadPayload;
                      delete window.__uploadPayload;
                      if (!base64Data) return 'ERROR: No upload payload found';

                      const binaryStr = atob(base64Data);
                      const bytes = new Uint8Array(binaryStr.length);
                      for (let i = 0; i < binaryStr.length; i++) {
                        bytes[i] = binaryStr.charCodeAt(i);
                      }
                      const file = new File([bytes], "${fileName}", { type: "${mimeType}" });

                      const inputs = document.querySelectorAll('input[type="file"]');
                      if (inputs.length === 0) return 'ERROR: No file input found on page';
                      const fileInput = inputs[0];

                      const dt = new DataTransfer();
                      dt.items.add(file);
                      Object.defineProperty(fileInput, 'files', {
                        value: dt.files, writable: true, configurable: true
                      });

                      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                      fileInput.dispatchEvent(new Event('input', { bubbles: true }));

                      const reactKey = Object.keys(fileInput).find(k =>
                        k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance') || k.startsWith('__reactProps')
                      );
                      if (reactKey && reactKey.startsWith('__reactProps')) {
                        const props = fileInput[reactKey];
                        if (props && props.onChange) {
                          props.onChange({ target: fileInput, currentTarget: fileInput });
                        }
                      }

                      return 'SUCCESS: ' + "${fileName}" + ' attached (' + file.size + ' bytes). React key: ' + (reactKey || 'none');
                    }`
                  }
                });

                const resultText = uploadResult.content && uploadResult.content[0] ? uploadResult.content[0].text : "";
                if (resultText.includes("ERROR")) {
                  logger.log(`Upload failed: ${resultText}`, "error");
                  lastAction = { failed_attempt: qwenDecision, error: resultText };
                } else {
                  logger.log(`Resume upload result: ${resultText}`, "success");
                  lastAction = qwenDecision;
                }
                await new Promise((resolve) => setTimeout(resolve, 3000));
              } catch (e) {
                logger.error(new Error(`File upload injection failed: ${e.message}`));
                lastAction = { failed_attempt: qwenDecision, error: e.message };
              }
            }
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

      // Dynamic Infinite Auto-Pagination
      const pageMatch = targetUrl.match(/page=(\d+)/);
      if (pageMatch && totalScrapedJobs > 0) {
        const currentPageNum = parseInt(pageMatch[1], 10);
        const nextPageNum = currentPageNum + 1;
        const nextPageUrl = targetUrl.replace(`page=${currentPageNum}`, `page=${nextPageNum}`);
        
        logger.log(
          `Auto-paginating: Discovered ${totalScrapedJobs} jobs on Page ${currentPageNum}. Appending Page ${nextPageNum} to queue...`,
          "info",
        );
        pendingJobs.push(nextPageUrl);
      } else if (pageMatch && totalScrapedJobs === 0) {
        logger.log(`End of search results reached at page ${pageMatch[1]}. No further jobs to extract.`, "info");
      }
    }

    // End of pendingJobs loop

    const sessionSummaryStr = `
========================================
           SESSION SUMMARY
========================================
STARTED: ${sessionLog.startTime}
COMPLETED: ${new Date().toLocaleString()}

✅ JOBS APPLIED TO (${sessionLog.jobsAppliedTo.length}):
${sessionLog.jobsAppliedTo.map((j, i) => `  ${i+1}. ${j.url}`).join('\\n')}

⏭️ JOBS SKIPPED (${sessionLog.jobsSkipped.length}):
${sessionLog.jobsSkipped.map((j, i) => `  ${i+1}. ${j.url}\n     Reason: ${j.reason}`).join('\\n')}
========================================`;

    logger.log(sessionSummaryStr, "info");
    
    // Also save it strictly to its own file
    const logFilename = path.join(logsDir, `session_summary_${Date.now()}.txt`);
    fs.writeFileSync(logFilename, sessionSummaryStr);

    logger.log(`Queue complete! Hanging script to preserve session... Summary written to ${logFilename}`, "info");
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

main();
