// Browser automation — shell cheatsheet for `browser-use`.
//
// browser-use is a Python CLI (browser-use.com) that drives Chrome via the
// DevTools Protocol with a persistent local daemon. It already solves auth
// persistence (--profile attaches to the principal's real Chrome profile,
// preserving every existing login), accessibility-based element refs
// ([10], [34], ...), batch execution, and screenshot/PDF export. Anything
// we'd wrap in a Glon program would be 90% wheel-recreation, so the agent
// talks to it via shell_exec and this program is just a REPL cheatsheet
// matching what the system prompt teaches.
//
// Install (required if you want any agent on this harness to browse the web):
//   pipx install browser-use         # cleanest; uses pipx's isolated venv
//   browser-use install              # downloads Chromium + system deps
//   browser-use doctor               # verifies installation
// Or via pip --user: `pip install --user browser-use`.

import type { ProgramDef, ProgramContext } from "../runtime.js";

const DIM = "\x1b[2m"; const BOLD = "\x1b[1m"; const CYAN = "\x1b[36m"; const RESET = "\x1b[0m";
const dim = (s: string) => `${DIM}${s}${RESET}`;
const bold = (s: string) => `${BOLD}${s}${RESET}`;
const cyan = (s: string) => `${CYAN}${s}${RESET}`;

const handler = async (_cmd: string, _args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	print([
		bold("  Browser automation") + dim(" — drive Chrome from shell. No actor."),
		"",
		dim("  CLI: browser-use (Python). doctor: browser-use doctor"),
		dim("  Install: pipx install browser-use && browser-use install"),
		"",
		dim("  Pin --session <name> per workflow so cookies + page state persist."),
		dim("  Add --profile to use the principal's REAL Chrome profile (skips login walls):"),
		`    ${cyan("browser-use --profile --session graice open https://discord.com/app")}`,
		`    ${cyan("browser-use --profile --session graice state")}`,
		"",
		dim("  Standard flow once a session is open (state returns elements as [N] refs):"),
		`    ${cyan("browser-use --session <name> state")}              ${dim("# tree of elements with [N] refs")}`,
		`    ${cyan("browser-use --session <name> click 10")}           ${dim("# click element [10]")}`,
		`    ${cyan("browser-use --session <name> input 12 \"value\"")}  ${dim("# type into element [12]")}`,
		`    ${cyan("browser-use --session <name> screenshot /tmp/r.png")}`,
		`    ${cyan("browser-use --session <name> extract \"goal\"")}    ${dim("# LLM-assisted data extraction")}`,
		`    ${cyan("browser-use --session <name> close")}              ${dim("# only when truly done")}`,
		"",
		dim("  Other useful subcommands:"),
		`    ${cyan("browser-use sessions")}                            ${dim("# list live sessions")}`,
		`    ${cyan("browser-use cookies export <path>")}               ${dim("# save auth state to a file")}`,
		`    ${cyan("browser-use cookies import <path>")}               ${dim("# load auth state from a file")}`,
		"",
		dim("  Showing the principal something visual: save with screenshot /tmp/<name>.png,"),
		dim("  then surface the path in your reply (or xdg-open the file on a desktop)."),
		"",
		dim("  Full reference: browser-use --help, browser-use <cmd> --help"),
		dim("  Project: https://github.com/browser-use/browser-use"),
	].join("\n"));
};

const program: ProgramDef = { handler };
export default program;
