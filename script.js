'use strict';

/* ============================================================
 * 海戦ゲーム（潜水艦）オンライン対戦版
 * 5x5マスの海戦図を2〜5人で共有し、同じ種類・耐久1の船を
 * 3隻ずつ秘密で配置して撃ち合う。移動なし・攻撃のみ。
 * バックエンドは Supabase（DB / Realtime / RLS / RPC）。
 * ============================================================ */

const COLS = ['A', 'B', 'C', 'D', 'E'];
const ROWS = [1, 2, 3, 4, 5];
const SETTINGS_KEY = 'sensuikan_supabase_config';
const NICKNAME_KEY = 'sensuikan_nickname';
const ROOM_ID_KEY = 'sensuikan_room_id';

// このゲーム用に用意した Supabase プロジェクトの既定値。
// publishable key はクライアント公開が前提の鍵で、実際の保護は
// supabase/schema.sql の Row Level Security 側で行っている。
// 別のプロジェクトを使いたい場合は「接続設定を変更」から上書きできる。
const DEFAULT_SUPABASE_URL = 'https://ichvuncoiyffzjvbmswi.supabase.co';
const DEFAULT_SUPABASE_KEY = 'sb_publishable_tsHY0-6akyn5O0OtTs1GkQ_SjLjuPt8';

function cellName(x, y) {
  return COLS[x] + ROWS[y];
}
function inBounds(x, y) {
  return x >= 0 && x < 5 && y >= 0 && y < 5;
}
function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/* ------------------------- 状態 ------------------------- */

let sb = null;

const state = {
  view: 'boot', // boot | settings | title | lobby | game | gameover
  userId: null,
  roomId: null,
  room: null,
  players: [],
  events: [],
  myShips: [],
  setupCells: [],
  channel: null,
  errorMessage: '',
  busy: false,
  showRules: false,
  pendingUrl: '',
  pendingKey: '',
};

/* ------------------------- DOM ヘルパ ------------------------- */

const app = document.getElementById('app');

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    Object.entries(attrs).forEach(([k, v]) => {
      if (v === null || v === undefined) return;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
  }
  (children || []).forEach((c) => {
    if (c === null || c === undefined) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

function setError(msg) {
  state.errorMessage = msg || '';
  render();
}

/* ------------------------- 起動 / Supabase 初期化 ------------------------- */

async function boot() {
  const saved = localStorage.getItem(SETTINGS_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      await initSupabase(parsed.url, parsed.key, false);
      return;
    } catch (e) {
      // 壊れた保存値は無視して既定値にフォールバックする
    }
  }
  if (DEFAULT_SUPABASE_URL && DEFAULT_SUPABASE_KEY) {
    await initSupabase(DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_KEY, false);
    return;
  }
  state.view = 'settings';
  render();
}

async function initSupabase(url, key, persist) {
  state.busy = true;
  render();
  try {
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error('supabase-js の読み込みに失敗しました。ネットワーク接続を確認してください。');
    }
    sb = window.supabase.createClient(url, key);

    let { data: sessionData } = await sb.auth.getSession();
    let session = sessionData && sessionData.session;
    if (!session) {
      const { data, error } = await sb.auth.signInAnonymously();
      if (error) throw error;
      session = data.session;
    }
    if (!session) throw new Error('匿名ログインに失敗しました。Supabaseの Authentication > Providers で Anonymous Sign-Ins を有効にしてください。');

    state.userId = session.user.id;
    if (persist) localStorage.setItem(SETTINGS_KEY, JSON.stringify({ url, key }));

    const savedRoomId = localStorage.getItem(ROOM_ID_KEY);
    if (savedRoomId) {
      state.roomId = savedRoomId;
      subscribeRoom(savedRoomId);
      await refreshRoomState();
      if (!state.room) {
        localStorage.removeItem(ROOM_ID_KEY);
        state.roomId = null;
        state.view = 'title';
      }
    } else {
      state.view = 'title';
    }
    state.errorMessage = '';
  } catch (e) {
    state.view = 'settings';
    state.errorMessage = '接続に失敗しました: ' + e.message;
  }
  state.busy = false;
  render();
}

/* ------------------------- ルーム状態の取得 / 購読 ------------------------- */

function subscribeRoom(roomId) {
  if (state.channel) {
    sb.removeChannel(state.channel);
    state.channel = null;
  }
  state.channel = sb
    .channel('room:' + roomId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, refreshRoomState)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'room_players', filter: `room_id=eq.${roomId}` }, refreshRoomState)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: `room_id=eq.${roomId}` }, refreshRoomState)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ships', filter: `room_id=eq.${roomId}` }, refreshRoomState)
    .subscribe();
}

async function refreshRoomState() {
  if (!state.roomId) return;
  const [roomRes, playersRes, eventsRes, shipsRes] = await Promise.all([
    sb.from('rooms').select('*').eq('id', state.roomId).maybeSingle(),
    sb.from('room_players').select('*').eq('room_id', state.roomId).order('seat'),
    sb.from('events').select('*').eq('room_id', state.roomId).order('created_at'),
    sb.from('ships').select('*').eq('room_id', state.roomId).eq('owner_id', state.userId),
  ]);

  state.room = roomRes.data || null;
  state.players = playersRes.data || [];
  state.events = eventsRes.data || [];
  state.myShips = shipsRes.data || [];

  if (!state.room) {
    state.view = 'title';
  } else if (state.room.status === 'lobby') {
    state.view = 'lobby';
  } else if (state.room.status === 'playing') {
    state.view = 'game';
  } else if (state.room.status === 'finished') {
    state.view = 'gameover';
  }
  render();
}

function nicknameOf(userId) {
  const p = state.players.find((p) => p.user_id === userId);
  return p ? p.nickname : '???';
}

function enterRoom(roomId) {
  state.roomId = roomId;
  localStorage.setItem(ROOM_ID_KEY, roomId);
  subscribeRoom(roomId);
  refreshRoomState();
}

function leaveRoomLocally() {
  if (state.channel) {
    sb.removeChannel(state.channel);
    state.channel = null;
  }
  localStorage.removeItem(ROOM_ID_KEY);
  state.roomId = null;
  state.room = null;
  state.players = [];
  state.events = [];
  state.myShips = [];
  state.setupCells = [];
  state.view = 'title';
  render();
}

/* ------------------------- 画面描画 ------------------------- */

function render() {
  app.innerHTML = '';
  app.appendChild(el('h1', {}, ['🚢 海戦ゲーム（潜水艦）オンライン']));

  if (state.errorMessage) {
    app.appendChild(el('div', { class: 'notice' }, [state.errorMessage]));
  }

  const rulesBtn = el('div', { class: 'rules-toggle' }, [
    el('button', { class: 'btn secondary', onclick: () => { state.showRules = !state.showRules; render(); } },
      [state.showRules ? 'ルールを閉じる' : 'ルールを見る']),
  ]);
  app.appendChild(rulesBtn);
  if (state.showRules) app.appendChild(renderRules());

  if (state.view === 'boot') app.appendChild(el('div', { class: 'card center-text' }, ['読み込み中…']));
  else if (state.view === 'settings') app.appendChild(renderSettings());
  else if (state.view === 'title') app.appendChild(renderTitle());
  else if (state.view === 'lobby') app.appendChild(renderLobby());
  else if (state.view === 'game') app.appendChild(renderGame());
  else if (state.view === 'gameover') app.appendChild(renderGameOver());

  app.appendChild(el('footer', { class: 'credit' }, ['5×5 共有海戦図 / 2〜5人オンライン対戦']));
}

function renderRules() {
  return el('div', { class: 'card' }, [
    el('p', { class: 'desc' }, [
      '全員で1枚の5×5海戦図を共有します。各プレイヤーは同じ種類・耐久1の船を3隻、他の人には秘密で配置します（他プレイヤーの船と同じマスに重なってもかまいません）。' +
      '自分の番では、自分の船があるマス以外ならどこでも1マス選んで攻撃できます。そのマスに他プレイヤーの船があれば、そのマスにいる全員の船が同時に沈みます。' +
      '攻撃したマスに自分の船が隣接していれば「水しぶき」として周囲に船があることが分かります。船をすべて沈められたプレイヤーは脱落し、最後まで残った1人の勝利です。',
    ]),
  ]);
}

/* ------------------------- 設定画面 ------------------------- */

function renderSettings() {
  return el('div', { class: 'card' }, [
    el('h2', {}, ['Supabase 接続設定']),
    el('p', { class: 'desc' }, [
      '通常は既定のプロジェクトに自動接続されるので、この画面を使う必要はありません。' +
      '別の Supabase プロジェクトを使いたい場合のみ、README の手順でプロジェクトを作成し、' +
      'SQL Editor で supabase/schema.sql を実行してから、Project Settings > API の URL と anon / publishable key をここに入力してください。' +
      '入力内容はこの端末のブラウザにのみ保存されます。',
    ]),
    el('div', { class: 'form-row' }, [
      el('label', {}, ['Project URL']),
      el('input', { class: 'input', id: 'sb-url', type: 'text', placeholder: 'https://xxxxx.supabase.co', value: state.pendingUrl || DEFAULT_SUPABASE_URL }, []),
    ]),
    el('div', { class: 'form-row' }, [
      el('label', {}, ['anon / publishable key']),
      el('input', { class: 'input', id: 'sb-key', type: 'text', placeholder: 'eyJhbGciOi... または sb_publishable_...', value: state.pendingKey || DEFAULT_SUPABASE_KEY }, []),
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn',
        disabled: state.busy ? 'true' : null,
        onclick: () => {
          const url = document.getElementById('sb-url').value.trim();
          const key = document.getElementById('sb-key').value.trim();
          state.pendingUrl = url;
          state.pendingKey = key;
          if (!url || !key) { setError('URL と anon key の両方を入力してください'); return; }
          initSupabase(url, key, true);
        },
      }, [state.busy ? '接続中…' : '接続する']),
    ]),
  ]);
}

/* ------------------------- タイトル画面 ------------------------- */

function renderTitle() {
  const savedNickname = localStorage.getItem(NICKNAME_KEY) || '';
  return el('div', { class: 'card' }, [
    el('div', { class: 'form-row' }, [
      el('label', {}, ['ニックネーム']),
      el('input', { class: 'input', id: 'nickname-input', type: 'text', value: savedNickname, maxlength: '16' }, []),
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn', disabled: state.busy ? 'true' : null, onclick: createRoom }, ['ルームを作る']),
    ]),
    el('hr', {}, []),
    el('div', { class: 'form-row' }, [
      el('label', {}, ['ルームコード']),
      el('input', { class: 'input', id: 'code-input', type: 'text', maxlength: '5', placeholder: '例: A1B2C' }, []),
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn secondary', disabled: state.busy ? 'true' : null, onclick: joinRoom }, ['ルームに参加する']),
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn secondary', onclick: () => { state.view = 'settings'; render(); } }, ['接続設定を変更']),
    ]),
  ]);
}

function readNickname() {
  const input = document.getElementById('nickname-input');
  const nickname = input ? input.value.trim() : '';
  if (nickname) localStorage.setItem(NICKNAME_KEY, nickname);
  return nickname;
}

async function createRoom() {
  const nickname = readNickname();
  if (!nickname) { setError('ニックネームを入力してください'); return; }
  state.busy = true;
  setError('');
  const { data, error } = await sb.rpc('create_room', { p_nickname: nickname });
  state.busy = false;
  if (error) { setError(error.message); return; }
  const row = Array.isArray(data) ? data[0] : data;
  enterRoom(row.room_id);
}

async function joinRoom() {
  const nickname = readNickname();
  const codeInput = document.getElementById('code-input');
  const code = codeInput ? codeInput.value.trim() : '';
  if (!nickname || !code) { setError('ニックネームとルームコードの両方を入力してください'); return; }
  state.busy = true;
  setError('');
  const { data, error } = await sb.rpc('join_room_by_code', { p_code: code, p_nickname: nickname });
  state.busy = false;
  if (error) { setError(error.message); return; }
  enterRoom(data);
}

/* ------------------------- ロビー画面 ------------------------- */

function renderLobby() {
  const room = state.room;
  const wrap = el('div', {}, []);
  const me = state.players.find((p) => p.user_id === state.userId);

  wrap.appendChild(el('div', { class: 'card center-text' }, [
    el('p', { class: 'desc' }, ['ルームコード（参加者に共有してください）']),
    el('div', { class: 'room-code' }, [room.code]),
  ]));

  wrap.appendChild(renderPlayerList());

  if (!me || !me.ships_placed) {
    wrap.appendChild(renderShipSetup());
  } else {
    wrap.appendChild(el('div', { class: 'card center-text' }, [
      el('p', { class: 'desc' }, ['配置が完了しました。他のプレイヤーを待っています…']),
    ]));
  }

  const allPlaced = state.players.length > 0 && state.players.every((p) => p.ships_placed);
  const isHost = room.host_id === state.userId;
  if (isHost) {
    const canStart = allPlaced && state.players.length >= 2 && state.players.length <= 5;
    wrap.appendChild(el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn',
        disabled: canStart && !state.busy ? null : 'true',
        onclick: startGame,
      }, ['ゲーム開始（' + state.players.length + '人）']),
    ]));
    if (!canStart) {
      wrap.appendChild(el('p', { class: 'notice' }, ['2〜5人が参加し、全員の配置が完了すると開始できます。']));
    }
  }

  wrap.appendChild(el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn secondary', onclick: leaveRoomLocally }, ['ルームを離れる（この端末から表示を消す）']),
  ]));

  wrap.appendChild(renderLog());
  return wrap;
}

function renderPlayerList() {
  return el('div', { class: 'card' }, [
    el('h2', {}, ['参加者 (' + state.players.length + '/5)']),
    el('div', { class: 'player-list' }, state.players.map((p) => el('div', { class: 'player-row' }, [
      el('span', {}, [p.nickname + (p.user_id === state.userId ? '（あなた）' : '') + (p.user_id === state.room.host_id ? ' 👑' : '')]),
      el('span', { class: 'small-tag' }, [p.ships_placed ? '配置済み' : '配置中…']),
    ]))),
  ]);
}

function renderShipSetup() {
  const wrap = el('div', { class: 'card' }, [
    el('h2', {}, ['艦艇配置']),
    el('p', { class: 'desc' }, ['耐久1の船を3隻、共有の海戦図の好きなマスに配置してください（他プレイヤーの船とは重なってもかまいません）。マスをタップして選択・解除します。']),
  ]);

  wrap.appendChild(el('div', { class: 'board-wrap' }, [renderBoardGrid({
    onCellClick: (x, y) => {
      const idx = state.setupCells.findIndex((c) => c.x === x && c.y === y);
      if (idx >= 0) {
        state.setupCells.splice(idx, 1);
      } else if (state.setupCells.length < 3) {
        state.setupCells.push({ x, y });
      }
      render();
    },
    cellClass: (x, y) => (state.setupCells.some((c) => c.x === x && c.y === y) ? 'target' : ''),
    cellContent: (x, y) => (state.setupCells.some((c) => c.x === x && c.y === y) ? el('span', {}, ['⚓']) : null),
  })]));

  wrap.appendChild(el('p', { class: 'notice' }, [`${state.setupCells.length} / 3 隻 選択中`]));
  wrap.appendChild(el('div', { class: 'btn-row' }, [
    el('button', {
      class: 'btn',
      disabled: state.setupCells.length === 3 && !state.busy ? null : 'true',
      onclick: submitShipSetup,
    }, ['配置を確定する']),
  ]));

  return wrap;
}

async function submitShipSetup() {
  if (state.setupCells.length !== 3) return;
  state.busy = true;
  setError('');
  const cells = state.setupCells.map((c) => [c.x, c.y]);
  const { error } = await sb.rpc('place_ships', { p_room_id: state.roomId, p_cells: cells });
  state.busy = false;
  if (error) { setError(error.message); render(); return; }
  state.setupCells = [];
  await refreshRoomState();
}

async function startGame() {
  state.busy = true;
  setError('');
  const { error } = await sb.rpc('start_game', { p_room_id: state.roomId });
  state.busy = false;
  if (error) { setError(error.message); render(); return; }
  await refreshRoomState();
}

/* ------------------------- 対戦画面 ------------------------- */

function renderGame() {
  const room = state.room;
  const wrap = el('div', {}, []);
  const myTurn = room.current_turn === state.userId;

  wrap.appendChild(el('div', { class: 'turn-banner' }, [
    myTurn ? 'あなたの番です' : `${nicknameOf(room.current_turn)} の番です`,
  ]));

  wrap.appendChild(renderPlayerStatusList());

  const aliveShips = state.myShips.filter((s) => s.alive);
  const ownCells = new Set(aliveShips.map((s) => s.x + ',' + s.y));

  wrap.appendChild(el('p', { class: 'desc' }, ['盤面には自分の船だけが表示されます。自分の船があるマス以外はどこでも攻撃できます。']));

  wrap.appendChild(el('div', { class: 'board-wrap' }, [renderBoardGrid({
    onCellClick: myTurn && !state.busy
      ? (x, y) => {
          if (ownCells.has(x + ',' + y)) return;
          doAttack(x, y);
        }
      : null,
    cellClass: (x, y) => (myTurn && !ownCells.has(x + ',' + y) ? 'clickable' : ''),
    cellContent: (x, y) => {
      const s = state.myShips.find((sh) => sh.x === x && sh.y === y);
      if (!s) return null;
      return el('span', { class: s.alive ? '' : 'sunk' }, [s.alive ? '⚓' : '×']);
    },
  })]));

  if (aliveShips.length === 0) {
    wrap.appendChild(el('p', { class: 'notice' }, ['あなたの船はすべて沈没しました。ゲームの結果をお待ちください。']));
  }

  wrap.appendChild(renderLog());
  return wrap;
}

function renderPlayerStatusList() {
  return el('div', { class: 'card' }, [
    el('h2', {}, ['プレイヤー']),
    el('div', { class: 'player-list' }, state.players.map((p) => el('div', { class: 'player-row' }, [
      el('span', {}, [
        p.nickname + (p.user_id === state.userId ? '（あなた）' : ''),
        p.user_id === state.room.current_turn ? ' 🎯' : '',
      ]),
      el('span', { class: 'small-tag' + (p.eliminated ? ' danger-tag' : '') }, [p.eliminated ? '脱落' : '生存']),
    ]))),
  ]);
}

async function doAttack(x, y) {
  state.busy = true;
  setError('');
  const { error } = await sb.rpc('attack', { p_room_id: state.roomId, p_x: x, p_y: y });
  state.busy = false;
  if (error) { setError(error.message); render(); return; }
  await refreshRoomState();
}

/* ------------------------- 交信記録 ------------------------- */

function formatEvent(e) {
  if (e.kind === 'attack') {
    const target = cellName(e.x, e.y);
    const hitNames = (e.hit_owner_ids || []).map(nicknameOf);
    const splashNames = (e.splash_owner_ids || []).map(nicknameOf);
    let text = `${nicknameOf(e.actor_id)} が ${target} を攻撃 → `;
    text += hitNames.length ? `命中！ ${hitNames.join('、')} の船が沈没！` : '空振り。';
    if (splashNames.length) {
      text += ` （水しぶき: ${splashNames.join('、')} の船が近くにいます）`;
    }
    return { text, cls: hitNames.length ? 'sunk' : '' };
  }
  return { text: e.message || '', cls: e.kind === 'gameover' ? 'sunk' : (e.kind === 'start' ? 'system' : '') };
}

function renderLog() {
  const box = el('div', { class: 'log' }, []);
  if (state.events.length === 0) {
    box.appendChild(el('div', { class: 'entry system' }, ['まだ行動はありません。']));
  } else {
    state.events.slice().reverse().forEach((e) => {
      const f = formatEvent(e);
      box.appendChild(el('div', { class: 'entry ' + f.cls }, [f.text]));
    });
  }
  return el('div', { class: 'card' }, [el('h2', {}, ['交信記録']), box]);
}

/* ------------------------- ゲーム終了 ------------------------- */

function renderGameOver() {
  const room = state.room;
  const winnerName = room.winner_id ? nicknameOf(room.winner_id) : '???';
  const wrap = el('div', { class: 'card center-text' }, [
    el('h2', {}, [`🏆 ${winnerName} の勝利！`]),
  ]);
  wrap.appendChild(renderPlayerStatusList());
  wrap.appendChild(renderLog());
  wrap.appendChild(el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn', onclick: leaveRoomLocally }, ['タイトルに戻る']),
  ]));
  return wrap;
}

/* ------------------------- 盤面グリッド共通描画 ------------------------- */

function renderBoardGrid({ onCellClick, cellClass, cellContent }) {
  const board = el('div', { class: 'board' }, []);
  board.appendChild(el('div', { class: 'hdr' }, ['']));
  COLS.forEach((c) => board.appendChild(el('div', { class: 'hdr' }, [c])));

  for (let y = 0; y < 5; y++) {
    board.appendChild(el('div', { class: 'hdr' }, [String(ROWS[y])]));
    for (let x = 0; x < 5; x++) {
      const extra = cellClass ? cellClass(x, y) : '';
      const clickable = typeof onCellClick === 'function';
      const cell = el('div', {
        class: 'cell' + (extra ? ' ' + extra : '') + (clickable ? ' clickable' : ''),
        onclick: clickable ? () => onCellClick(x, y) : null,
      }, []);
      const content = cellContent ? cellContent(x, y) : null;
      if (content) cell.appendChild(content);
      board.appendChild(cell);
    }
  }
  return board;
}

boot();
