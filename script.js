'use strict';

/* ============================================================
 * 海戦ゲーム（潜水艦）- 5x5 マス目の紙とペンで遊ぶ海戦ゲームを
 * 一台の端末でパス&プレイ（回し打ち）できるようにした実装。
 * ============================================================ */

const COLS = ['A', 'B', 'C', 'D', 'E'];
const ROWS = [1, 2, 3, 4, 5];

const SHIP_DEFS = {
  warship: { key: 'warship', symbol: 'W', name: '戦艦', maxHp: 3 },
  destroyer: { key: 'destroyer', symbol: 'D', name: '駆逐艦', maxHp: 2 },
  submarine: { key: 'submarine', symbol: 'S', name: '潜水艦', maxHp: 1 },
};
const SHIP_ORDER = ['warship', 'destroyer', 'submarine'];

const DIRECTIONS = {
  north: { label: '北 (row 1 方向)', dx: 0, dy: -1 },
  south: { label: '南 (row 5 方向)', dx: 0, dy: 1 },
  west: { label: '西 (A 方向)', dx: -1, dy: 0 },
  east: { label: '東 (E 方向)', dx: 1, dy: 0 },
};

function cellName(x, y) {
  return COLS[x] + ROWS[y];
}
function inBounds(x, y) {
  return x >= 0 && x < 5 && y >= 0 && y < 5;
}
function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function createPlayer(name) {
  const ships = {};
  SHIP_ORDER.forEach((key) => {
    const def = SHIP_DEFS[key];
    ships[key] = { key, symbol: def.symbol, name: def.name, maxHp: def.maxHp, hp: def.maxHp, x: null, y: null, sunk: false };
  });
  return { name, ships };
}

function aliveShips(player) {
  return SHIP_ORDER.map((k) => player.ships[k]).filter((s) => !s.sunk);
}
function allPlaced(player) {
  return SHIP_ORDER.every((k) => player.ships[k].x !== null);
}
function shipAt(player, x, y) {
  return aliveShips(player).find((s) => s.x === x && s.y === y) || null;
}

/* ------------------------- 状態 ------------------------- */

const state = {
  phase: 'title', // title | setup | handoff | turn | gameover
  setupPlayerIndex: 0,
  players: [createPlayer('プレイヤー1'), createPlayer('プレイヤー2')],
  currentPlayerIndex: 0,
  selectedShipForSetup: null,
  actionMode: null, // null | 'attack' | 'move-select-ship' | 'move-select-dir' | 'move-select-dist'
  moveShipKey: null,
  moveDir: null,
  handoffMessage: '',
  handoffAction: null,
  log: [],
  winner: null,
  showRules: false,
};

function resetGame() {
  state.phase = 'title';
  state.setupPlayerIndex = 0;
  state.players = [createPlayer('プレイヤー1'), createPlayer('プレイヤー2')];
  state.currentPlayerIndex = 0;
  state.selectedShipForSetup = null;
  state.actionMode = null;
  state.moveShipKey = null;
  state.moveDir = null;
  state.handoffMessage = '';
  state.handoffAction = null;
  state.log = [];
  state.winner = null;
  render();
}

function addLog(text, cls) {
  state.log.push({ text, cls: cls || '' });
}

function goToHandoff(message, action) {
  state.handoffMessage = message;
  state.handoffAction = action;
  state.phase = 'handoff';
  render();
}

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

function render() {
  app.innerHTML = '';
  app.appendChild(el('h1', {}, ['🚢 海戦ゲーム（潜水艦）']));

  const rulesBtn = el('div', { class: 'rules-toggle' }, [
    el('button', { class: 'btn secondary', onclick: () => { state.showRules = !state.showRules; render(); } },
      [state.showRules ? 'ルールを閉じる' : 'ルールを見る']),
  ]);
  app.appendChild(rulesBtn);
  if (state.showRules) app.appendChild(renderRules());

  if (state.phase === 'title') app.appendChild(renderTitle());
  else if (state.phase === 'setup') app.appendChild(renderSetup());
  else if (state.phase === 'handoff') app.appendChild(renderHandoff());
  else if (state.phase === 'turn') app.appendChild(renderTurn());
  else if (state.phase === 'gameover') app.appendChild(renderGameOver());

  app.appendChild(el('footer', { class: 'credit' }, ['5×5 海戦図 / 1台の端末でパス&プレイ']));
}

function renderRules() {
  return el('div', { class: 'card' }, [
    el('p', { class: 'desc' }, [
      '5×5マスの海戦図に、戦艦(W・耐久3)、駆逐艦(D・耐久2)、潜水艦(S・耐久1)を1隻ずつ配置します。' +
      'ターンごとに「攻撃」か「移動」を選びます。攻撃は自分の艦に隣接する(斜め含む)マスにしか届きません。' +
      '攻撃したマスに相手の艦が隣接していると、相手は「水しぶき」としてその艦の種類を申告します。' +
      '移動は東西南北のいずれかに好きなマス数だけ、1隻だけ動かせます。相手の艦をすべて沈めたら勝利です。',
    ]),
  ]);
}

function renderTitle() {
  return el('div', { class: 'card center-text' }, [
    el('p', { class: 'desc' }, ['2人で1台の端末を使って遊ぶパス&プレイ形式です。自分の番以外は画面を見ないでください。']),
    el('button', { class: 'btn', onclick: () => { state.phase = 'setup'; state.setupPlayerIndex = 0; render(); } }, ['ゲームを始める']),
  ]);
}

/* ------------------------- セットアップ ------------------------- */

function renderSetup() {
  const idx = state.setupPlayerIndex;
  const player = state.players[idx];
  const wrap = el('div', {}, []);
  wrap.appendChild(el('h2', {}, [`${player.name} の艦艇配置`]));
  wrap.appendChild(el('p', { class: 'desc' }, ['3隻すべてを異なるマスに配置してください。艦種を選んでからマスをタップします。']));

  const palette = el('div', { class: 'ship-palette' }, SHIP_ORDER.map((key) => {
    const ship = player.ships[key];
    const selected = state.selectedShipForSetup === key;
    return el('div', {
      class: 'ship-btn' + (selected ? ' selected' : '') + (ship.x !== null ? ' placed' : ''),
      onclick: () => { state.selectedShipForSetup = selected ? null : key; render(); },
    }, [
      `${ship.symbol} ${ship.name}`,
      el('span', { class: 'small' }, [`耐久 ${ship.maxHp}${ship.x !== null ? ` (${cellName(ship.x, ship.y)})` : ''}`]),
    ]);
  }));
  wrap.appendChild(palette);

  wrap.appendChild(el('div', { class: 'board-wrap' }, [renderBoardGrid({
    onCellClick: (x, y) => {
      const occupied = SHIP_ORDER.find((k) => {
        const s = player.ships[k];
        return s.x === x && s.y === y;
      });
      if (state.selectedShipForSetup) {
        if (occupied && occupied !== state.selectedShipForSetup) return; // 他の自艦とは重複不可
        player.ships[state.selectedShipForSetup].x = x;
        player.ships[state.selectedShipForSetup].y = y;
        render();
      } else if (occupied) {
        player.ships[occupied].x = null;
        player.ships[occupied].y = null;
        render();
      }
    },
    cellClass: (x, y) => {
      const occupied = SHIP_ORDER.find((k) => {
        const s = player.ships[k];
        return s.x === x && s.y === y;
      });
      return occupied ? 'clickable' : (state.selectedShipForSetup ? 'target' : '');
    },
    cellContent: (x, y) => {
      const occupied = SHIP_ORDER.find((k) => {
        const s = player.ships[k];
        return s.x === x && s.y === y;
      });
      if (!occupied) return null;
      return el('span', {}, [player.ships[occupied].symbol]);
    },
  })]));

  if (allPlaced(player)) {
    wrap.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn', onclick: () => finishSetup(idx) }, ['配置完了 →']),
    ]));
  } else {
    wrap.appendChild(el('p', { class: 'notice' }, ['あと ' + SHIP_ORDER.filter((k) => player.ships[k].x === null).length + ' 隻配置してください。']));
  }
  return wrap;
}

function finishSetup(idx) {
  if (idx === 0) {
    goToHandoff('プレイヤー2に交代してください。', () => {
      state.setupPlayerIndex = 1;
      state.selectedShipForSetup = null;
      state.phase = 'setup';
    });
  } else {
    goToHandoff('配置が完了しました。先手を決めます。', () => {
      state.currentPlayerIndex = Math.random() < 0.5 ? 0 : 1;
      addLog(`${state.players[state.currentPlayerIndex].name} が先手です。`, 'system');
      state.selectedShipForSetup = null;
      state.phase = 'turn';
    });
  }
}

/* ------------------------- ハンドオフ ------------------------- */

function renderHandoff() {
  return el('div', { class: 'card handoff' }, [
    el('div', { class: 'icon' }, ['🙈']),
    el('p', { class: 'desc' }, [state.handoffMessage]),
    el('button', { class: 'btn', onclick: () => { state.handoffAction(); render(); } }, ['準備ができました（タップして表示）']),
  ]);
}

/* ------------------------- 対戦ターン ------------------------- */

function renderTurn() {
  const cur = state.players[state.currentPlayerIndex];
  const opp = state.players[1 - state.currentPlayerIndex];
  const wrap = el('div', {}, []);

  wrap.appendChild(el('div', { class: 'turn-banner' }, [`${cur.name} のターン`]));
  wrap.appendChild(renderStatusRow(cur));

  if (state.actionMode === null) {
    wrap.appendChild(el('div', { class: 'board-wrap' }, [renderOwnBoard(cur)]));
    wrap.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn', onclick: () => { state.actionMode = 'attack'; render(); } }, ['⚓ 攻撃']),
      el('button', { class: 'btn secondary', onclick: () => { state.actionMode = 'move-select-ship'; render(); } }, ['➡ 移動']),
    ]));
  } else if (state.actionMode === 'attack') {
    wrap.appendChild(renderAttackUI(cur, opp));
  } else if (state.actionMode === 'move-select-ship') {
    wrap.appendChild(renderMoveSelectShip(cur));
  } else if (state.actionMode === 'move-select-dir') {
    wrap.appendChild(renderMoveSelectDir(cur));
  } else if (state.actionMode === 'move-select-dist') {
    wrap.appendChild(renderMoveSelectDist(cur));
  }

  wrap.appendChild(renderLog());
  return wrap;
}

function renderStatusRow(player) {
  return el('div', { class: 'status-row' }, SHIP_ORDER.map((key) => {
    const s = player.ships[key];
    const dots = [];
    for (let i = 0; i < s.maxHp; i++) {
      dots.push(el('span', { class: 'dot' + (i < s.hp ? '' : ' lost') }, []));
    }
    return el('div', { class: 'status-chip' }, [
      `${s.symbol} ${s.sunk ? '沈没' : ''}`,
      el('div', { class: 'hp-dots' }, dots),
    ]);
  }));
}

function renderOwnBoard(player) {
  return renderBoardGrid({
    onCellClick: null,
    cellClass: () => '',
    cellContent: (x, y) => {
      const s = shipAt(player, x, y);
      if (!s) return null;
      return el('span', {}, [
        s.symbol,
        el('span', { class: 'hp' }, [`${s.hp}/${s.maxHp}`]),
      ]);
    },
  });
}

function renderAttackUI(attacker, defender) {
  const wrap = el('div', {}, []);
  wrap.appendChild(el('p', { class: 'desc' }, ['自分の艦に隣接する(斜め含む)マスを1つ選んで攻撃します。']));

  const targets = new Set();
  aliveShips(attacker).forEach((s) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nx = s.x + dx, ny = s.y + dy;
        if (inBounds(nx, ny)) targets.add(nx + ',' + ny);
      }
    }
  });

  wrap.appendChild(el('div', { class: 'board-wrap' }, [renderBoardGrid({
    onCellClick: (x, y) => {
      if (!targets.has(x + ',' + y)) return;
      resolveAttack(attacker, defender, x, y);
    },
    cellClass: (x, y) => (targets.has(x + ',' + y) ? 'target' : ''),
    cellContent: () => null,
  })]));

  wrap.appendChild(el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn secondary', onclick: () => { state.actionMode = null; render(); } }, ['← やめる']),
  ]));
  return wrap;
}

function resolveAttack(attacker, defender, x, y) {
  const target = cellName(x, y);
  const hitShip = shipAt(defender, x, y);
  const splashes = aliveShips(defender).filter((s) => s !== hitShip && chebyshev(s, { x, y }) === 1);

  if (hitShip) {
    hitShip.hp -= 1;
    if (hitShip.hp <= 0) {
      hitShip.sunk = true;
      addLog(`${attacker.name} が ${target} を攻撃 → 命中！ ${defender.name} の ${hitShip.name}(${hitShip.symbol}) を撃沈した！`, 'sunk');
    } else {
      addLog(`${attacker.name} が ${target} を攻撃 → 命中！（${defender.name} の艦、耐久残り ${hitShip.hp}）`, 'hit');
    }
  } else {
    addLog(`${attacker.name} が ${target} を攻撃 → 空振り。`, '');
  }

  splashes.forEach((s) => {
    addLog(`${defender.name} が水しぶきを申告：${target} の隣接マスに ${s.name}(${s.symbol}) がいる！`, 'hit');
  });

  state.actionMode = null;

  if (aliveShips(defender).length === 0) {
    state.winner = state.currentPlayerIndex;
    state.phase = 'gameover';
    render();
    return;
  }

  const nextIndex = 1 - state.currentPlayerIndex;
  goToHandoff(`${state.players[nextIndex].name} に交代してください。`, () => {
    state.currentPlayerIndex = nextIndex;
    state.phase = 'turn';
  });
}

function renderMoveSelectShip(player) {
  const wrap = el('div', {}, []);
  wrap.appendChild(el('p', { class: 'desc' }, ['移動させる艦を選んでください。']));
  wrap.appendChild(el('div', { class: 'board-wrap' }, [renderOwnBoard(player)]));
  const options = aliveShips(player).map((s) => el('button', {
    class: 'btn',
    onclick: () => { state.moveShipKey = s.key; state.actionMode = 'move-select-dir'; render(); },
  }, [`${s.symbol} ${s.name} (${cellName(s.x, s.y)})`]));
  wrap.appendChild(el('div', { class: 'btn-row' }, options));
  wrap.appendChild(el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn secondary', onclick: () => { state.actionMode = null; render(); } }, ['← やめる']),
  ]));
  return wrap;
}

function maxDistance(player, ship, dir) {
  const d = DIRECTIONS[dir];
  let dist = 0;
  let x = ship.x, y = ship.y;
  while (true) {
    const nx = x + d.dx, ny = y + d.dy;
    if (!inBounds(nx, ny)) break;
    const blocker = SHIP_ORDER.some((k) => {
      const other = player.ships[k];
      return other.key !== ship.key && !other.sunk && other.x === nx && other.y === ny;
    });
    if (blocker) break;
    dist += 1;
    x = nx; y = ny;
  }
  return dist;
}

function renderMoveSelectDir(player) {
  const ship = player.ships[state.moveShipKey];
  const wrap = el('div', {}, []);
  wrap.appendChild(el('p', { class: 'desc' }, [`${ship.symbol} ${ship.name} の移動方向を選んでください。(現在地: ${cellName(ship.x, ship.y)})`]));
  wrap.appendChild(el('div', { class: 'board-wrap' }, [renderOwnBoard(player)]));

  const buttons = Object.entries(DIRECTIONS).map(([key, d]) => {
    const max = maxDistance(player, ship, key);
    return el('button', {
      class: 'btn' + (max === 0 ? ' secondary' : ''),
      disabled: max === 0 ? 'true' : null,
      onclick: () => { if (max === 0) return; state.moveDir = key; state.actionMode = 'move-select-dist'; render(); },
    }, [`${d.label}（最大${max}マス）`]);
  });
  wrap.appendChild(el('div', { class: 'btn-row' }, buttons));
  wrap.appendChild(el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn secondary', onclick: () => { state.actionMode = 'move-select-ship'; render(); } }, ['← 艦選択に戻る']),
  ]));
  return wrap;
}

function renderMoveSelectDist(player) {
  const ship = player.ships[state.moveShipKey];
  const max = maxDistance(player, ship, state.moveDir);
  const wrap = el('div', {}, []);
  wrap.appendChild(el('p', { class: 'desc' }, ['移動するマス数を選んでください。']));
  wrap.appendChild(el('div', { class: 'board-wrap' }, [renderOwnBoard(player)]));

  const distButtons = [];
  for (let i = 1; i <= max; i++) {
    distButtons.push(el('button', {
      class: 'btn',
      onclick: () => resolveMove(player, ship, state.moveDir, i),
    }, [`${i} マス`]));
  }
  wrap.appendChild(el('div', { class: 'btn-row' }, distButtons));
  wrap.appendChild(el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn secondary', onclick: () => { state.actionMode = 'move-select-dir'; render(); } }, ['← 方向選択に戻る']),
  ]));
  return wrap;
}

function resolveMove(player, ship, dir, dist) {
  const d = DIRECTIONS[dir];
  const nx = ship.x + d.dx * dist;
  const ny = ship.y + d.dy * dist;
  const from = cellName(ship.x, ship.y);
  ship.x = nx;
  ship.y = ny;
  const to = cellName(nx, ny);

  addLog(`${player.name}: ${ship.symbol} ${ship.name} を ${DIRECTIONS[dir].label} に ${dist} マス移動（${from} → ${to}）。`, 'move');

  state.actionMode = null;
  state.moveShipKey = null;
  state.moveDir = null;

  const nextIndex = 1 - state.currentPlayerIndex;
  goToHandoff(`${state.players[nextIndex].name} に交代してください。`, () => {
    state.currentPlayerIndex = nextIndex;
    state.phase = 'turn';
  });
}

function renderLog() {
  const box = el('div', { class: 'log' }, []);
  if (state.log.length === 0) {
    box.appendChild(el('div', { class: 'entry system' }, ['まだ行動はありません。']));
  } else {
    state.log.slice().reverse().forEach((entry) => {
      box.appendChild(el('div', { class: 'entry ' + entry.cls }, [entry.text]));
    });
  }
  return el('div', { class: 'card' }, [el('h2', {}, ['交信記録']), box]);
}

/* ------------------------- ゲーム終了 ------------------------- */

function renderGameOver() {
  const winner = state.players[state.winner];
  const wrap = el('div', { class: 'card center-text' }, [
    el('h2', {}, [`🏆 ${winner.name} の勝利！`]),
    el('p', { class: 'desc' }, ['両プレイヤーの海戦図を公開します。']),
  ]);

  state.players.forEach((p) => {
    wrap.appendChild(el('h2', {}, [p.name]));
    wrap.appendChild(el('div', { class: 'board-wrap' }, [renderBoardGrid({
      onCellClick: null,
      cellClass: () => '',
      cellContent: (x, y) => {
        const s = SHIP_ORDER.map((k) => p.ships[k]).find((sh) => sh.x === x && sh.y === y);
        if (!s) return null;
        return el('span', {}, [s.symbol, el('span', { class: 'hp' }, [s.sunk ? '沈没' : `${s.hp}/${s.maxHp}`])]);
      },
    })]));
  });

  wrap.appendChild(renderLog());
  wrap.appendChild(el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn', onclick: resetGame }, ['もう一度あそぶ']),
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

render();
