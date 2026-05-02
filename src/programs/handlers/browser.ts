// Browser automation — shell cheatsheet for Skyvern.
//
// Skyvern (https://github.com/Skyvern-AI/skyvern) is a Python service that
// drives Chrome via Playwright with a vision-LLM swarm on top, planning and
// executing actions from natural-language prompts. We use it instead of a
// thin DevTools CLI because reliability on real-world sites is much higher:
// no per-site selectors to babysit, robust to layout changes, handles
// CAPTCHAs / login walls / multi-step flows out of the box.
//
// Skyvern is a long-running local server (default :8000), not a one-shot CLI:
// the operator starts it once with `skyvern run server` (or `skyvern run all`
// for server + UI on :8080), and agents drive it via HTTP.
//
// Install (required if any agent on this harness will browse the web):
//   pip install skyvern         # or: pipx install skyvern
//   skyvern quickstart          # initialises ~/.skyvern (DB, credentials, .env)
//   skyvern run server          # long-running; binds 127.0.0.1:8000
// Configure an LLM key in `~/.skyvern/.env` (LLM_KEY=ANTHROPIC + ANTHROPIC_API_KEY=...
// or LLM_KEY=OPENAI_GPT4O + OPENAI_API_KEY=...). Local API key is generated
// at quickstart time and lives in the same .env; export it so curl can use it.
//
// To use the principal's REAL Chrome (so Skyvern inherits all existing logins),
// enable Chrome remote debugging once and set BROWSER_TYPE=cdp-connect plus
// BROWSER_REMOTE_DEBUGGING_URL=http://127.0.0.1:9222 in ~/.skyvern/.env, then
// restart the server. See https://www.skyvern.com/docs/optimization/browser-tunneling.

import type { ProgramDef, ProgramContext } from "../runtime.js";

const DIM = "\x1b[2m"; const BOLD = "\x1b[1m"; const CYAN = "\x1b[36m"; const RESET = "\x1b[0m";
const dim = (s: string) => `${DIM}${s}${RESET}`;
const bold = (s: string) => `${BOLD}${s}${RESET}`;
const cyan = (s: string) => `${CYAN}${s}${RESET}`;

const handler = async (_cmd: string, _args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	print([
		bold("  Browser automation") + dim(" — drive Chrome via Skyvern. No actor."),
		"",
		dim("  Service: Skyvern (https://github.com/Skyvern-AI/skyvern), local on :8000"),
		dim("  Install: pip install skyvern && skyvern quickstart && skyvern run server &"),
		dim("  Status:  skyvern status   |   skyvern stop all"),
		"",
		dim("  Auth: skyvern quickstart writes credentials to ~/.skyvern/.env"),
		dim("  (LLM key + a local API key). Export the local API key for curl:"),
		`    ${cyan("export SKYVERN_API_KEY=$(grep SKYVERN_API_KEY ~/.skyvern/.env | cut -d= -f2)")}`,
		"",
		dim("  One-shot task (submit + poll + extract result, single shell call):"),
		`    ${cyan("RUN=$(curl -sS -X POST http://localhost:8000/v1/run/tasks \\")}`,
		`    ${cyan("  -H \"Content-Type: application/json\" -H \"x-api-key: $SKYVERN_API_KEY\" \\")}`,
		`    ${cyan("  -d '{\"prompt\":\"<goal>\",\"url\":\"<URL>\",\"engine\":\"skyvern-2.0\",\"max_steps\":15}' \\")}`,
		`    ${cyan("  | jq -r '.run_id // .task_id'); \\")}`,
		`    ${cyan("until S=$(curl -sS -H \"x-api-key: $SKYVERN_API_KEY\" \\")}`,
		`    ${cyan("  http://localhost:8000/v1/runs/$RUN | jq -r '.status'); \\")}`,
		`    ${cyan("[ \"$S\" = completed ] || [ \"$S\" = failed ] || [ \"$S\" = terminated ]; \\")}`,
		`    ${cyan("do sleep 5; done; \\")}`,
		`    ${cyan("curl -sS -H \"x-api-key: $SKYVERN_API_KEY\" \\")}`,
		`    ${cyan("  http://localhost:8000/v1/runs/$RUN | jq .")}`,
		"",
		dim("  Structured extraction (consistent JSON output via JSON Schema):"),
		`    ${cyan("# add data_extraction_schema to the POST body. Example below:")}`,
		`    ${cyan("-d '{")}`,
		`    ${cyan("  \"prompt\": \"Get the top post on hacker news\",")}`,
		`    ${cyan("  \"url\": \"https://news.ycombinator.com\",")}`,
		`    ${cyan("  \"data_extraction_schema\": {")}`,
		`    ${cyan("    \"type\": \"object\",")}`,
		`    ${cyan("    \"properties\": {")}`,
		`    ${cyan("      \"title\":  {\"type\":\"string\"},")}`,
		`    ${cyan("      \"url\":    {\"type\":\"string\"},")}`,
		`    ${cyan("      \"points\": {\"type\":\"integer\"}")}`,
		`    ${cyan("    }")}`,
		`    ${cyan("  }")}`,
		`    ${cyan("}'")}`,
		"",
		dim("  Use the principal's REAL Chrome (skips login walls):"),
		dim("  1) Enable Chrome remote debugging once (chrome://inspect/#remote-debugging),"),
		dim("     or run: skyvern init browser"),
		dim("  2) In ~/.skyvern/.env set:"),
		`       ${cyan("BROWSER_TYPE=cdp-connect")}`,
		`       ${cyan("BROWSER_REMOTE_DEBUGGING_URL=http://127.0.0.1:9222")}`,
		dim("  3) Restart: skyvern stop all && skyvern run server &"),
		dim("  Subsequent runs reuse the live Chrome session, with all existing logins."),
		"",
		dim("  Engines (set engine= in the task body):"),
		dim("    skyvern-2.0   — default; planner+actor+validator swarm; best on multi-step"),
		dim("    skyvern-1.0   — leaner; good for single-page form fills"),
		dim("    openai-cua    — OpenAI Computer Use (requires OpenAI key)"),
		dim("    anthropic-cua — Claude Sonnet computer-use tool (requires Anthropic key)"),
		"",
		dim("  Other useful endpoints:"),
		`    ${cyan("GET  /v1/runs/{run_id}")}             ${dim("# state, status, extracted_information")}`,
		`    ${cyan("POST /v1/runs/{run_id}/cancel")}      ${dim("# stop a stuck task")}`,
		`    ${cyan("GET  /v1/runs?limit=10")}             ${dim("# recent runs")}`,
		"",
		dim("  Full reference:  https://www.skyvern.com/docs/api-reference"),
		dim("  Project:         https://github.com/Skyvern-AI/skyvern"),
	].join("\n"));
};

const program: ProgramDef = { handler };
export default program;
