import type { ProgramDef, ProgramContext } from "../runtime.js";
import { dim, bold, cyan, red, green, yellow } from "../shared.js";

// ── Board model ─────────────────────────────────────────────────

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],             // diagonals
];

/** Pull a string out of a Value-like object (handles Rivet serialization shapes). */
function extractString(v: any) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null) {
    if (typeof v["stringValue"] === "string") return v["stringValue"];
  }
  return "";
}

/** Extract a BoardState from an object's fields Record. */
function readBoard(fields: any) {
  const cells: string[] = [];
  for (let i = 0; i < 9; i++) {
    const v = fields["cell_" + i];
    const raw = extractString(v);
    cells.push((raw === "X" || raw === "O") ? raw : "");
  }
  const turn = extractString(fields["turn"]) || "X";
  const statusRaw = extractString(fields["status"]);
  const status = (statusRaw === "X_wins" || statusRaw === "O_wins" || statusRaw === "draw")
    ? statusRaw : "playing";
  const moveCount = cells.filter(c => c !== "").length;
  return { cells, turn, status, moveCount };
}

// ── Board rendering ─────────────────────────────────────────────

function cellDisplay(cell: string, index: number) {
  if (cell === "X") return cyan(bold(" X "));
  if (cell === "O") return red(bold(" O "));
  return dim(" " + index + " ");
}

function renderBoard(board: any) {
  const c = board.cells;
  const lines = [
    "",
    "  " + cellDisplay(c[0], 0) + "\u2502" + cellDisplay(c[1], 1) + "\u2502" + cellDisplay(c[2], 2),
    "  " + dim("\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u253c\u2500\u2500\u2500"),
    "  " + cellDisplay(c[3], 3) + "\u2502" + cellDisplay(c[4], 4) + "\u2502" + cellDisplay(c[5], 5),
    "  " + dim("\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u253c\u2500\u2500\u2500"),
    "  " + cellDisplay(c[6], 6) + "\u2502" + cellDisplay(c[7], 7) + "\u2502" + cellDisplay(c[8], 8),
    "",
  ];

  if (board.status === "playing") {
    lines.push("  " + bold(board.turn) + "'s turn  " + dim("(move " + (board.moveCount + 1) + ")"));
  } else if (board.status === "draw") {
    lines.push("  " + yellow(bold("Draw!")));
  } else {
    const winner = board.status === "X_wins" ? "X" : "O";
    const color = winner === "X" ? cyan : red;
    lines.push("  " + color(bold(winner + " wins!")) + "  " + dim("(" + board.moveCount + " moves)"));
  }

  return lines.join("\n");
}

// ── Handler ─────────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
  const { client, store, resolveId, stringVal, print, listChangeFiles, readChangeByHex, hexEncode } = ctx as any;

  // ── Helpers that need ctx ───────────────────────────────────

  /** Validate and compute the fields for a move. Does NOT write anything. */
  function computeMove(board: any, position: number, player?: string) {
    if (board.status !== "playing") {
      return { ok: false, error: "game over: " + board.status, fields: {} as any, newStatus: board.status };
    }
    if (position < 0 || position > 8) {
      return { ok: false, error: "invalid position: " + position + " (use 0-8)", fields: {} as any, newStatus: "playing" };
    }
    if (board.cells[position] !== "") {
      return { ok: false, error: "cell " + position + " already taken by " + board.cells[position], fields: {} as any, newStatus: "playing" };
    }

    const who = player !== undefined ? player : board.turn;
    if (who !== board.turn) {
      return { ok: false, error: "not " + who + "'s turn (current: " + board.turn + ")", fields: {} as any, newStatus: "playing" };
    }

    // Apply the move to a copy.
    const newCells = board.cells.slice();
    newCells[position] = who;

    // Check for win.
    let winner: string | null = null;
    for (const [a, b, c] of WIN_LINES) {
      if (newCells[a] && newCells[a] === newCells[b] && newCells[b] === newCells[c]) {
        winner = newCells[a];
        break;
      }
    }

    // Check for draw.
    const filled = newCells.filter((c: string) => c !== "").length;
    const isDraw = !winner && filled === 9;

    const newStatus = winner ? winner + "_wins" : isDraw ? "draw" : "playing";
    const nextTurn = who === "X" ? "O" : "X";

    // Build the field updates as a single Change.
    const fields: any = {};
    fields["cell_" + position] = stringVal(who);
    fields["turn"] = stringVal(newStatus === "playing" ? nextTurn : who);
    fields["status"] = stringVal(newStatus);
    if (winner) {
      fields["winner"] = stringVal(winner);
    }

    return { ok: true, fields, newStatus };
  }

  function renderMoveHistory(objectId: string) {
    const allHex = listChangeFiles();
    const changes: any[] = [];
    for (const hexId of allHex) {
      const c = readChangeByHex(hexId);
      if (c && c.objectId === objectId) changes.push(c);
    }
    changes.sort((a: any, b: any) => a.timestamp - b.timestamp);

    const lines: string[] = [];
    let moveNum = 0;

    for (const c of changes) {
      const hex = hexEncode(c.id).slice(0, 12);
      const ts = new Date(c.timestamp).toISOString().slice(11, 19);

      for (const op of c.ops) {
        if (op.objectCreate) {
          lines.push("  " + dim(hex) + "  " + dim(ts) + "  " + green("new game"));
        } else if (op.fieldSet) {
          const key = op.fieldSet.key;
          const val = extractString(op.fieldSet.value);

          // Only show cell moves, not turn/status updates.
          if (key.startsWith("cell_") && (val === "X" || val === "O")) {
            moveNum++;
            const pos = key.slice(5);
            const color = val === "X" ? cyan : red;
            lines.push("  " + dim(hex) + "  " + dim(ts) + "  " + bold("#" + moveNum) + " " + color(val) + " \u2192 position " + pos);
          } else if (key === "status" && val !== "playing") {
            const label = val === "draw" ? yellow("draw") :
              val === "X_wins" ? cyan(bold("X wins")) :
              red(bold("O wins"));
            lines.push("  " + dim(hex) + "  " + dim(ts) + "  " + label);
          }
        }
      }
    }

    if (lines.length === 0) return "  " + dim("(no moves)");
    return lines.join("\n");
  }

  function newGameFields() {
    const fields: any = {
      turn: stringVal("X"),
      status: stringVal("playing"),
    };
    for (let i = 0; i < 9; i++) {
      fields["cell_" + i] = stringVal("");
    }
    return fields;
  }

  // ── Command dispatch ──────────────────────────────────────────

  switch (cmd) {
    case "new": {
      const name = args.join(" ") || "tic-tac-toe";
      const fields = newGameFields();
      fields["name"] = stringVal(name);
      const fieldsJson = JSON.stringify(fields);
      const id = await store.create("game", fieldsJson);
      print(green("New game: ") + bold(id));
      print(dim("  Use ttt board " + id.slice(0, 8) + " to see the board"));
      print(dim("  Use ttt move " + id.slice(0, 8) + " <0-8> to play"));
      break;
    }

    case "board": {
      const raw = args[0];
      if (!raw) { print(red("Usage: ttt board <id>")); break; }
      const id = await resolveId(raw);
      if (!id) { print(red("Not found: ") + raw); break; }
      const state = await store.get(id);
      if (!state) { print(red("Not found")); break; }
      const board = readBoard(state.fields);
      print(renderBoard(board));
      break;
    }

    case "move": {
      const raw = args[0];
      const posStr = args[1];
      if (!raw || posStr === undefined) {
        print(red("Usage: ttt move <id> <position 0-8>"));
        break;
      }
      const id = await resolveId(raw);
      if (!id) { print(red("Not found: ") + raw); break; }
      const pos = parseInt(posStr, 10);
      if (isNaN(pos)) { print(red("Position must be 0-8")); break; }

      // Read current state from the actor.
      const state = await store.get(id);
      if (!state) { print(red("Not found")); break; }
      const board = readBoard(state.fields);

      // Validate and compute the move.
      const result = computeMove(board, pos);
      if (!result.ok) {
        print(red("  " + result.error));
        break;
      }

      // Apply all field updates as a single Change.
      const actor = client.objectActor.getOrCreate([id]);
      await actor.setFields(JSON.stringify(result.fields));

      // Re-read and render.
      const updated = await store.get(id);
      if (updated) {
        const newBoard = readBoard(updated.fields);
        print(renderBoard(newBoard));
      }
      break;
    }

    case "history": {
      const raw = args[0];
      if (!raw) { print(red("Usage: ttt history <id>")); break; }
      const id = await resolveId(raw);
      if (!id) { print(red("Not found: ") + raw); break; }
      print(renderMoveHistory(id));
      break;
    }

    default: {
      print([
        bold("  Tic-Tac-Toe"),
        "    " + cyan("ttt new") + " " + dim("[name]") + "           start a new game",
        "    " + cyan("ttt board") + " " + dim("<id>") + "            show the board",
        "    " + cyan("ttt move") + " " + dim("<id> <0-8>") + "      make a move",
        "    " + cyan("ttt history") + " " + dim("<id>") + "          move-by-move replay",
        "",
        "  " + dim("Positions:"),
        "    " + dim("0") + "|" + dim("1") + "|" + dim("2"),
        "    " + dim("-+-+-"),
        "    " + dim("3") + "|" + dim("4") + "|" + dim("5"),
        "    " + dim("-+-+-"),
        "    " + dim("6") + "|" + dim("7") + "|" + dim("8"),
        "",
        "  " + dim("Every move is a content-addressed Change in the DAG."),
        "  " + dim("Use history <id> to see the full change log."),
      ].join("\n"));
    }
  }
};

const program: ProgramDef = { handler };
export default program;
