export interface Env {
  TELEGRAM_TOKEN: string;
  SECRET_PATH: string;
  DB: D1Database;
}

type TgUser = { id: number; username?: string; first_name?: string };
type Update = any;
type ActionResult = { ok: boolean; message?: string };
type GameRow = {
  id: number;
  chat_id: string;
  status: "active" | "ended";
  started_at: number;
  ended_at?: number | null;
  buy_in_cents: number;
  status_message_id?: string | null;
};

type PlayerRow = {
  user_id: string;
  username: string;
  first_name: string;
  approved_cents: number;
  pending_count: number;
};

type PendingRow = {
  id: number;
  user_id: string;
  username: string;
  first_name: string;
  amount_cents: number;
  approvals: number;
  rejects: number;
};

const APPROVALS_REQUIRED = 1;
const MAX_PENDING_ROWS_IN_KEYBOARD = 5;

const T = (token: string, method: string, payload: Record<string, any>) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

const now = () => Math.floor(Date.now() / 1000);
const toCents = (n: number) => Math.round(n * 100);
const fmtMoney = (cents: number) => (cents / 100).toFixed(2);

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("ok");
    }

    if (request.method === "POST" && url.pathname === `/webhook/${env.SECRET_PATH}`) {
      const update: Update = await request.json().catch(() => ({}));

      if (update.message) {
        await handleMessage(update.message, env);
      } else if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      }

      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },
};

async function handleMessage(msg: any, env: Env) {
  const chat = msg.chat;
  const text: string = msg.text || "";
  const from: TgUser = msg.from;

  if (chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  const [rawCmd, ...rest] = text.trim().split(/\s+/);
  const cmd = (rawCmd || "").toLowerCase().split("@")[0];
  const argText = rest.join(" ");

  switch (cmd) {
    case "/startgame": {
      const result = await startGame(env, chat.id, argText);
      if (!result.ok && result.message) {
        await send(env, chat.id, result.message);
      }
      return;
    }
    case "/joingame": {
      const result = await joinGame(env, chat.id, from);
      if (!result.ok && result.message) {
        await send(env, chat.id, result.message);
      }
      return;
    }
    case "/buyin": {
      const result = await buyIn(env, chat.id, from, argText);
      if (!result.ok && result.message) {
        await send(env, chat.id, result.message);
      }
      return;
    }
    case "/status": {
      const ok = await refreshGameMessage(env, chat.id, undefined, false);
      if (!ok) {
        await send(env, chat.id, "No active game.");
      }
      return;
    }
    case "/endgame": {
      const result = await endGame(env, chat.id);
      if (!result.ok && result.message) {
        await send(env, chat.id, result.message);
      }
      return;
    }
    default:
      return;
  }
}

async function handleCallback(cb: any, env: Env) {
  const { id: cbId, from, data, message } = cb;
  const chatId = message?.chat?.id;
  if (!chatId) {
    await ack(env, cbId, "Missing chat context.");
    return;
  }

  let toast = "Done";
  try {
    const payload = JSON.parse(data);
    switch (payload.t) {
      case "join": {
        const result = await joinGame(env, chatId, from);
        toast = result.message || (result.ok ? "Joined." : "Unable to join.");
        break;
      }
      case "buyin": {
        const result = await buyIn(env, chatId, from);
        toast = result.message || (result.ok ? "Buy-in requested." : "Unable to buy-in.");
        break;
      }
      case "approve":
      case "reject": {
        const result = await processApproval(env, chatId, payload.id, from, payload.t);
        toast = result.message || (result.ok ? "Recorded." : "Unable to record.");
        break;
      }
      case "refresh": {
        const ok = await refreshGameMessage(env, chatId, undefined, false);
        toast = ok ? "Status refreshed." : "Nothing to refresh.";
        break;
      }
      case "end": {
        const result = await endGame(env, chatId);
        toast = result.message || (result.ok ? "Game ended." : "Unable to end game.");
        break;
      }
      default:
        toast = "Unsupported action.";
    }
  } catch (err) {
    console.log("callback error", err);
    toast = "Invalid action.";
  }

  await ack(env, cbId, toast);
}

function ack(env: Env, cbId: string, text: string) {
  return T(env.TELEGRAM_TOKEN, "answerCallbackQuery", { callback_query_id: cbId, text, show_alert: false });
}

async function startGame(env: Env, chatId: number, argText: string): Promise<ActionResult> {
  const db = env.DB;
  const existing = await db
    .prepare(
      "SELECT id FROM games WHERE chat_id = ? AND status = 'active'"
    )
    .bind(String(chatId))
    .first();
  if (existing) {
    return { ok: false, message: "There is already an active game in this chat." };
  }

  const match = argText?.match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    return { ok: false, message: "Usage: /startgame <buy-in amount>. Example: /startgame 50" };
  }
  const numeric = parseFloat(match[1]);
  if (!(numeric > 0)) {
    return { ok: false, message: "Buy-in must be greater than zero." };
  }
  const buyInCents = toCents(numeric);

  const result = await db
    .prepare(
      "INSERT INTO games (chat_id, started_at, status, buy_in_cents) VALUES (?, ?, 'active', ?)"
    )
    .bind(String(chatId), now(), buyInCents)
    .run();

  const game = await getGameById(env, Number(result.meta.last_row_id));
  if (game) {
    await refreshGameMessage(env, chatId, game);
  }

  return { ok: true, message: "Game started." };
}

async function joinGame(env: Env, chatId: number, user: TgUser): Promise<ActionResult> {
  const game = await currentGame(env, chatId);
  if (!game) return { ok: false, message: "No active game. Use /startgame first." };

  const existing = await env.DB.prepare("SELECT id FROM players WHERE game_id=? AND user_id=?")
    .bind(game.id, String(user.id))
    .first();
  if (existing) {
    return { ok: false, message: "You are already part of this game." };
  }

  await env.DB.prepare(
    "INSERT INTO players (game_id, user_id, username, first_name, joined_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(game.id, String(user.id), user.username || null, user.first_name || null, now()).run();

  await refreshGameMessage(env, chatId, game);
  return { ok: true, message: "Joined the game." };
}

async function buyIn(env: Env, chatId: number, user: TgUser, argText?: string): Promise<ActionResult> {
  const game = await currentGame(env, chatId);
  if (!game) return { ok: false, message: "No active game. Use /startgame first." };

  const isPlayer = await env.DB.prepare("SELECT id FROM players WHERE game_id=? AND user_id=?")
    .bind(game.id, String(user.id))
    .first();
  if (!isPlayer) {
    return { ok: false, message: "Please join the game before buying in." };
  }

  let cents: number | null = null;
  const trimmed = argText?.trim();
  if (trimmed) {
    const match = trimmed.match(/(\d+(?:\.\d+)?)/);
    if (!match) return { ok: false, message: "Usage: /buyin <amount>. Example: /buyin 50" };
    const numeric = parseFloat(match[1]);
    if (!(numeric > 0)) return { ok: false, message: "Amount must be greater than zero." };
    cents = toCents(numeric);
  } else {
    cents = Number(game.buy_in_cents) || 0;
  }

  if (!(cents > 0)) {
    return { ok: false, message: "No default buy-in found. Restart the game with /startgame <amount>." };
  }

  await env.DB.prepare(
    "INSERT INTO buyins (game_id, user_id, amount_cents, created_at, status) VALUES (?, ?, ?, ?, 'pending')"
  ).bind(game.id, String(user.id), cents, now()).run();

  await refreshGameMessage(env, chatId, game);
  return { ok: true, message: "Buy-in submitted for approval." };
}

async function processApproval(
  env: Env,
  chatId: number,
  buyinId: number,
  approver: TgUser,
  decision: "approve" | "reject"
): Promise<ActionResult> {
  if (!buyinId) return { ok: false, message: "Invalid buy-in." };

  const buyin = await env.DB.prepare(
    "SELECT b.id, b.game_id, b.user_id, b.status FROM buyins b WHERE b.id=?"
  ).bind(buyinId).first();
  if (!buyin) return { ok: false, message: "Buy-in not found." };
  if (buyin.status !== "pending") return { ok: false, message: "Buy-in already resolved." };

  if (String(buyin.user_id) === String(approver.id)) {
    return { ok: false, message: "You cannot vote on your own buy-in." };
  }

  const player = await env.DB.prepare("SELECT id FROM players WHERE game_id=? AND user_id=?")
    .bind(buyin.game_id, String(approver.id))
    .first();
  if (!player) {
    return { ok: false, message: "Only players can approve or reject buy-ins." };
  }

  try {
    await env.DB.prepare(
      "INSERT INTO approvals (buyin_id, approver_user_id, decision, created_at) VALUES (?, ?, ?, ?)"
    ).bind(buyinId, String(approver.id), decision, now()).run();
  } catch (_) {
    // duplicate vote
  }

  const counts = await env.DB.prepare(
    "SELECT decision, COUNT(*) as c FROM approvals WHERE buyin_id=? GROUP BY decision"
  ).bind(buyinId).all();
  const approvals = counts.results.find(r => r.decision === "approve")?.c || 0;
  const rejects = counts.results.find(r => r.decision === "reject")?.c || 0;

  let message = `Recorded (${approvals}/${APPROVALS_REQUIRED}).`;
  let statusChanged = false;
  if (approvals >= APPROVALS_REQUIRED) {
    await env.DB.prepare("UPDATE buyins SET status='approved' WHERE id=?").bind(buyinId).run();
    message = `Buy-in #${buyinId} approved.`;
    statusChanged = true;
  } else if (rejects >= APPROVALS_REQUIRED) {
    await env.DB.prepare("UPDATE buyins SET status='rejected' WHERE id=?").bind(buyinId).run();
    message = `Buy-in #${buyinId} rejected.`;
    statusChanged = true;
  }

  const game = await getGameById(env, buyin.game_id);
  if (game) {
    await refreshGameMessage(env, Number(game.chat_id), game);
  } else {
    await refreshGameMessage(env, chatId);
  }

  return { ok: true, message: statusChanged ? message : `Vote recorded (${approvals}/${APPROVALS_REQUIRED}).` };
}

async function endGame(env: Env, chatId: number): Promise<ActionResult> {
  const game = await currentGame(env, chatId);
  if (!game) return { ok: false, message: "No active game." };

  await env.DB.prepare("UPDATE games SET status='ended', ended_at=? WHERE id=?")
    .bind(now(), game.id)
    .run();

  const updated = await getGameById(env, game.id);
  if (updated) {
    await refreshGameMessage(env, chatId, updated);
  }
  return { ok: true, message: "Game ended." };
}

async function refreshGameMessage(
  env: Env,
  chatId: number,
  providedGame?: GameRow | null,
  allowCreate: boolean = true
): Promise<boolean> {
  const game = providedGame ?? (await currentGame(env, chatId));
  if (!game) return false;

  const state = await composeGameState(env, game.id);
  const text = buildStatusText(game, state);
  const reply_markup = buildStatusKeyboard(game, state);

  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup,
  };

  if (game.status_message_id) {
    const messageId = Number(game.status_message_id);
    try {
      await callTelegram(env, "editMessageText", { ...payload, message_id: messageId });
      return true;
    } catch (err) {
      console.log("Failed to edit status message.", err);
      if (!allowCreate) {
        return false;
      }
    }
  } else if (!allowCreate) {
    return false;
  }

  try {
    const result = await callTelegram(env, "sendMessage", payload);
    if (result?.message_id) {
      await env.DB.prepare("UPDATE games SET status_message_id=? WHERE id=?")
        .bind(String(result.message_id), game.id)
        .run();
      return true;
    }
  } catch (err) {
    console.log("Failed to send status message.", err);
  }

  return false;
}

async function composeGameState(env: Env, gameId: number): Promise<{ players: PlayerRow[]; pending: PendingRow[] }> {
  const playersData = await env.DB.prepare(
    `SELECT
        p.user_id,
        COALESCE(p.username, '') as username,
        COALESCE(p.first_name, '') as first_name,
        COALESCE(SUM(CASE WHEN b.status='approved' THEN b.amount_cents ELSE 0 END), 0) as approved_cents,
        COALESCE(SUM(CASE WHEN b.status='pending' THEN 1 ELSE 0 END), 0) as pending_count
     FROM players p
     LEFT JOIN buyins b ON b.game_id = p.game_id AND b.user_id = p.user_id
     WHERE p.game_id=?
     GROUP BY p.user_id
     ORDER BY approved_cents DESC, username`
  ).bind(gameId).all();

  const pendingData = await env.DB.prepare(
    `SELECT
        b.id,
        b.user_id,
        COALESCE(p.username,'') as username,
        COALESCE(p.first_name,'') as first_name,
        b.amount_cents,
        COALESCE(SUM(CASE WHEN a.decision='approve' THEN 1 ELSE 0 END),0) as approvals,
        COALESCE(SUM(CASE WHEN a.decision='reject' THEN 1 ELSE 0 END),0) as rejects
     FROM buyins b
     LEFT JOIN approvals a ON a.buyin_id = b.id
     LEFT JOIN players p ON p.game_id = b.game_id AND p.user_id = b.user_id
     WHERE b.game_id=? AND b.status='pending'
     GROUP BY b.id
     ORDER BY b.id ASC`
  ).bind(gameId).all();

  return {
    players: playersData.results as PlayerRow[],
    pending: pendingData.results as PendingRow[],
  };
}

function buildStatusText(game: GameRow, state: { players: PlayerRow[]; pending: PendingRow[] }) {
  const lines: string[] = [];
  const header = game.status === "ended" ? "*Game ended*" : "*Poker Night*";
  lines.push(header);
  lines.push(`Buy-in: ${fmtMoney(Number(game.buy_in_cents || 0))}`);
  lines.push("");

  if (state.players.length === 0) {
    lines.push("_No players yet._");
  } else {
    lines.push("*Players*");
    for (const player of state.players) {
      const label = displayName(player.username, player.first_name, player.user_id);
      const pendingText = player.pending_count ? ` (pending ${player.pending_count})` : "";
      lines.push(`- ${label}: ${fmtMoney(player.approved_cents)}${pendingText}`);
    }
  }

  if (state.pending.length) {
    lines.push("");
    lines.push("*Pending buy-ins*");
    for (const pending of state.pending) {
      const label = displayName(pending.username, pending.first_name, pending.user_id);
      lines.push(
        `#${pending.id} ${label} - ${fmtMoney(pending.amount_cents)} (${pending.approvals}/${APPROVALS_REQUIRED})`
      );
    }
  }

  if (game.status === "ended") {
    lines.push("");
    lines.push("Start a new game with /startgame <amount>.");
  }

  return lines.join("\n");
}

function buildStatusKeyboard(game: GameRow, state: { pending: PendingRow[] }) {
  if (game.status !== "active") return undefined;

  const inline_keyboard: any[] = [
    [
      { text: "Join game", callback_data: encodeAction({ t: "join" }) },
      { text: `Buy-in (${fmtMoney(Number(game.buy_in_cents || 0))})`, callback_data: encodeAction({ t: "buyin" }) },
    ],
    [
      { text: "Refresh", callback_data: encodeAction({ t: "refresh" }) },
      { text: "End game", callback_data: encodeAction({ t: "end" }) },
    ],
  ];

  const limitedPending = state.pending.slice(0, MAX_PENDING_ROWS_IN_KEYBOARD);
  for (const pending of limitedPending) {
    inline_keyboard.push([
      {
        text: `Approve #${pending.id} (${pending.approvals}/${APPROVALS_REQUIRED})`,
        callback_data: encodeAction({ t: "approve", id: pending.id }),
      },
      {
        text: `Reject #${pending.id} (${pending.rejects}/${APPROVALS_REQUIRED})`,
        callback_data: encodeAction({ t: "reject", id: pending.id }),
      },
    ]);
  }

  return { inline_keyboard };
}

function encodeAction(payload: Record<string, unknown>) {
  return JSON.stringify(payload);
}

async function currentGame(env: Env, chatId: number): Promise<GameRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, chat_id, status, started_at, ended_at, buy_in_cents, status_message_id
     FROM games
     WHERE chat_id=? AND status='active'
     ORDER BY id DESC
     LIMIT 1`
  ).bind(String(chatId)).first();
  return row as GameRow || null;
}

async function getGameById(env: Env, id: number): Promise<GameRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, chat_id, status, started_at, ended_at, buy_in_cents, status_message_id
     FROM games WHERE id=?`
  ).bind(id).first();
  return row as GameRow || null;
}

function displayName(username: string, firstName: string, fallback: string | number) {
  if (username) return `@${username}`;
  if (firstName) return firstName;
  return maskUser(fallback);
}

function maskUser(id: string | number) {
  const s = String(id);
  if (s.length <= 4) return s;
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

async function callTelegram(env: Env, method: string, payload: Record<string, any>) {
  const response = await T(env.TELEGRAM_TOKEN, method, payload);
  const json = await response.json().catch(() => null);
  if (!json?.ok) {
    throw new Error(json?.description || "Telegram API error");
  }
  return json.result;
}

async function send(env: Env, chatId: number, text: string) {
  await T(env.TELEGRAM_TOKEN, "sendMessage", { chat_id: chatId, text });
}
