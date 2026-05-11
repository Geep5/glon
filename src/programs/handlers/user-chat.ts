// user-chat — generic surface for pushing messages to the human user.
//
// Programs like /trade need to alert the user ("incoming swap from
// alice@example.com — accept?") without baking in any specific chat surface.
// This program owns the "tell the user something" call.
//
// Routing (in order; each independent, all run if applicable):
//   1. ctx.emit("user-chat:notify", …)        — picked up by web/CLI subscribers
//   2. /discord sendChannel  if GLON_USER_DISCORD_CHANNEL_ID is set
//   3. /discord send         if GLON_USER_PEER_ID is set
//   4. ctx.print fallback                     — always shown in daemon logs
//
// CLI:
//   user-chat status                show wiring + recent count
//   user-chat notify <text...>      manual test; emit a user notification

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, green } from "../shared.js";

interface NotifyInput {
	text: string;
	urgency?: "low" | "normal" | "high";
	source?: string;
}

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	if (cmd === "status") {
		print(bold("  user-chat"));
		print(dim("    discord channel: ") + (process.env.GLON_USER_DISCORD_CHANNEL_ID ?? "(not set)"));
		print(dim("    discord peer:    ") + (process.env.GLON_USER_PEER_ID ?? "(not set)"));
		print(dim("    notifications:   ") + (ctx.state?.totalNotified ?? 0));
		return;
	}
	if (cmd === "notify") {
		const text = args.join(" ");
		if (!text) { print(`Usage: user-chat notify <text...>`); return; }
		await doNotify(ctx, { text, urgency: "normal", source: "cli" });
		print(green("notified"));
		return;
	}
	print([
		bold("  user-chat") + dim(" — generic surface for messages to the human"),
		`    ${cyan("user-chat status")}              show routing + counts`,
		`    ${cyan("user-chat notify")} ${dim("<text...>")}      send a notification (manual test)`,
		"",
		dim("    Set GLON_USER_DISCORD_CHANNEL_ID or GLON_USER_PEER_ID to route to Discord."),
		dim("    Subscribers can listen on the \"user-chat:notify\" emit channel."),
	].join("\n"));
};

async function doNotify(ctx: ProgramContext, input: NotifyInput): Promise<{ delivered: string[] }> {
	const text = input.text;
	if (!text) throw new Error("user-chat.notify: text required");
	const urgency = input.urgency ?? "normal";
	const source = input.source ?? "unknown";
	const delivered: string[] = [];

	// 1. Always emit — frontends and tests subscribe here.
	try {
		ctx.emit("user-chat:notify", { text, urgency, source, timestamp: Date.now() });
		delivered.push("emit");
	} catch { /* emit is best-effort */ }

	// 2. Optionally route to a Discord channel.
	const channelId = process.env.GLON_USER_DISCORD_CHANNEL_ID;
	if (channelId) {
		try {
			await ctx.dispatchProgram("/discord", "sendChannel", [{ channel_id: channelId, text }]);
			delivered.push(`discord-channel:${channelId.slice(0, 8)}`);
		} catch (err: any) {
			ctx.print?.(dim(`  [user-chat] discord channel send failed: ${err?.message ?? String(err)}`));
		}
	}

	// 3. Optionally route to a Discord peer DM.
	const peerId = process.env.GLON_USER_PEER_ID;
	if (peerId) {
		try {
			await ctx.dispatchProgram("/discord", "send", [{ peer_id: peerId, text }]);
			delivered.push(`discord-peer:${peerId.slice(0, 8)}`);
		} catch (err: any) {
			ctx.print?.(dim(`  [user-chat] discord peer send failed: ${err?.message ?? String(err)}`));
		}
	}

	// 4. Always log to the daemon — visible in tail-blocks / dev-server.log.
	ctx.print?.(`[user-chat${urgency !== "normal" ? ` ${urgency}` : ""}] ${text}`);
	delivered.push("print");

	const state = ctx.state as any;
	state.totalNotified = (state.totalNotified ?? 0) + 1;
	state.lastNotifiedAt = Date.now();
	state.lastSource = source;

	return { delivered };
}

const actorDef: ProgramActorDef = {
	createState: () => ({ totalNotified: 0, lastNotifiedAt: 0, lastSource: "" }),
	typedActions: {
		notify: {
			description: "Push a message to the user across all configured surfaces.",
			inputSchema: {
				type: "object",
				required: ["text"],
				properties: {
					text: { type: "string" },
					urgency: { type: "string" },
					source: { type: "string" },
				},
			},
			handler: async (ctx, input: NotifyInput) => doNotify(ctx, input),
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

export const __test = { doNotify };
