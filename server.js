const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'images')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

function parseCSV(str) {
  // Auto-detect delimiter: use the first line to choose between ';' and ','.
  const firstLine = str.slice(0, str.indexOf('\n') === -1 ? str.length : str.indexOf('\n'));
  const delimiter = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inQuotes) {
      if (c === '"') {
        if (str[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (field !== '' || row.length) {
        row.push(field);
        rows.push(row);
      }
      field = '';
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Arquivo de perguntas: questions.csv por padrão, ou outro via QUESTIONS_FILE=arquivo.csv
const QUESTIONS_FILE = path.resolve(__dirname, process.env.QUESTIONS_FILE || 'questions.csv');
const csvText = fs.readFileSync(QUESTIONS_FILE, 'utf8').replace(/^﻿/, '');
// Identifica a versão do CSV: se mudar, o progresso salvo da partida é descartado.
const csvHash = crypto.createHash('sha1').update(csvText).digest('hex');
const rawRows = parseCSV(csvText);

function shuffle(arr) {
  // Fisher–Yates: embaralha no lugar
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Lê e valida as perguntas. Linhas com problema são ignoradas com um aviso,
// em vez de quebrarem o jogo no meio da aula.
function loadQuestions(rows) {
  const list = [];
  const problems = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2; // linha no arquivo (1 = cabeçalho)
    const clean = (s) => String(s ?? '').trim();
    const question = clean(r[1]);
    const answers = [r[2], r[3], r[4], r[5]].map(clean);
    const correctRaw = clean(r[6]);
    const correct = Number(correctRaw);
    const image = clean(r[7]) || null;

    if (!question) return problems.push(`linha ${line}: pergunta vazia`);
    if (answers.filter(Boolean).length < 2) return problems.push(`linha ${line}: menos de 2 alternativas`);
    if (correctRaw === '' || !Number.isInteger(correct) || correct < 0 || correct > 3)
      return problems.push(`linha ${line}: coluna "correct" deve ser 0, 1, 2 ou 3 (veio "${correctRaw}")`);
    if (!answers[correct]) return problems.push(`linha ${line}: "correct" aponta para uma alternativa vazia`);
    if (image && !/^https?:\/\//i.test(image)) {
      const local = path.join(__dirname, image.replace(/^\/+/, ''));
      if (!fs.existsSync(local)) problems.push(`linha ${line}: imagem não encontrada (${image}) — pergunta mantida sem imagem`);
    }

    list.push({
      id: line,
      category: clean(r[0]) || 'Geral',
      question,
      answers,
      correct,
      image: image && !/^https?:\/\//i.test(image) ? '/' + image.replace(/^\/+/, '') : image,
    });
  });
  // Imagens locais inexistentes são removidas para não aparecer um ícone quebrado.
  for (const q of list) {
    if (q.image && q.image.startsWith('/') && !fs.existsSync(path.join(__dirname, q.image))) q.image = null;
  }
  if (problems.length) {
    console.warn(`⚠️  ${path.basename(QUESTIONS_FILE)}: ${problems.length} problema(s) encontrado(s):`);
    for (const p of problems) console.warn('   - ' + p);
  }
  console.log(`${list.length} pergunta(s) carregada(s).`);
  return list;
}

const questions = shuffle(loadQuestions(rawRows));

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
const joinUrl = () => {
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  if (process.env.RAILWAY_STATIC_URL) return process.env.RAILWAY_STATIC_URL;
  if (process.env.DEPLOYED_URL) return process.env.DEPLOYED_URL;
  return `http://${getLanIp()}:${PORT}`;
};

let configCache = null;
app.get('/config', async (req, res) => {
  if (!configCache) {
    const url = joinUrl();
    configCache = QRCode.toDataURL(url, {
      width: 340,
      margin: 1,
      color: { dark: '#0d0d1a', light: '#ffffff' },
    })
      .then((qr) => ({ joinUrl: url, qrDataUrl: qr }))
      .catch((err) => ({ joinUrl: url, error: err.message }));
  }
  res.json(await configCache);
});

// ---------- Pontuação ----------
// Todos que apertarem podem responder. Quem acerta ganha pontos conforme a
// ordem em que apertou: 1º = POINTS_MAX, cada posição seguinte vale
// POINTS_STEP a menos, nunca abaixo de POINTS_MIN. Resposta errada perde PENALTY.
const POINTS_MAX = 100;
const POINTS_STEP = 20;
const POINTS_MIN = 20;
const PENALTY = 20;
const ANSWER_MS = 10000; // tempo para responder, contado a partir do momento em que a equipe apertou
const ANSWER_SLACK_MS = 750;
// Só as primeiras MAX_BUZZERS equipes podem apertar em cada pergunta; as demais ficam
// de fora. Evita que alguém espere de propósito para pesquisar a resposta.
const MAX_BUZZERS = Number(process.env.MAX_BUZZERS) || 5; // tolerância de rede para respostas no limite
// Revela sozinho quando todas as equipes conectadas já responderam (ou esgotaram o tempo).
const AUTO_REVEAL = true;
const AUTO_REVEAL_DELAY_MS = 1500;
// Onde a partida é salva, para sobreviver a um reinício do servidor.
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'game-state.json');

const pointsForPosition = (pos) => Math.max(POINTS_MIN, POINTS_MAX - pos * POINTS_STEP);

const state = {
  // teamId -> { id, name, score, socketId }
  // Equipes nunca são apagadas sozinhas (só pelo botão do apresentador),
  // para ninguém perder pontos porque o celular bloqueou a tela.
  teams: new Map(),
  socketTeams: new Map(),
  questionIndex: -1,
  phase: 'idle', // idle | buzzing | revealed | finished
  // teamId -> { position, deadline, answer: number|null, delta: number|null }
  // Map preserva a ordem de inserção = ordem em que apertaram.
  responses: new Map(),
};

const currentQuestion = () =>
  state.questionIndex >= 0 && state.questionIndex < questions.length
    ? questions[state.questionIndex]
    : null;

const isOnline = (t) => !!(t.socketId && io.sockets.sockets.get(t.socketId));
const normName = (s) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');

const publicTeams = () =>
  Array.from(state.teams.values()).map((t) => ({
    id: t.id,
    name: t.name,
    score: t.score,
    online: isOnline(t),
  }));

function teamForSocket(socketId) {
  const teamId = state.socketTeams.get(socketId);
  return teamId ? state.teams.get(teamId) || null : null;
}

function attachSocket(team, socket) {
  // Se a equipe estava aberta em outro aparelho/aba, desvincula o socket antigo.
  if (team.socketId && team.socketId !== socket.id) state.socketTeams.delete(team.socketId);
  team.socketId = socket.id;
  state.socketTeams.set(socket.id, team.id);
}

// ---------- Persistência ----------
// A partida é guardada em dois lugares:
//  1. no arquivo STATE_FILE (funciona quando o servidor roda num computador);
//  2. no navegador do apresentador (localStorage), para hospedagens como o Render
//     gratuito, em que o disco é apagado quando o servidor reinicia. Quando o
//     servidor volta vazio, a tela /host devolve essa cópia automaticamente.

// Muda a cada vez que o servidor sobe: o apresentador só restaura uma cópia
// feita por uma execução anterior do servidor.
const bootId = crypto.randomUUID();
const HOST_BACKUP_MAX_AGE_MS = 6 * 60 * 60 * 1000; // cópias com mais de 6h são ignoradas (outra aula)
const hostSockets = new Set();

function snapshot() {
  return {
    version: 1,
    bootId,
    savedAt: Date.now(),
    csvHash,
    questionOrder: questions.map((q) => q.id),
    questionIndex: state.questionIndex,
    phase: state.phase,
    teams: [...state.teams.values()].map(({ id, name, score }) => ({ id, name, score })),
    responses: [...state.responses.entries()],
  };
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot()));
    fs.renameSync(tmp, STATE_FILE); // troca atômica: nunca deixa um arquivo pela metade
  } catch (err) {
    console.warn('Não foi possível salvar a partida:', err.message);
  }
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

// Aplica uma cópia salva ao estado atual. Os dados podem vir de um navegador,
// então tudo é conferido. Equipes que entraram depois do reinício são mantidas;
// se uma delas tem o mesmo nome de uma equipe da cópia, as duas viram uma só
// (o celular continua conectado e recupera os pontos).
function applySnapshot(saved) {
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.teams)) return false;
  const idMap = new Map();
  for (const t of saved.teams.slice(0, 500)) {
    if (!t || typeof t.id !== 'string' || typeof t.name !== 'string' || !t.name.trim()) continue;
    const name = t.name.trim().slice(0, 30);
    const score = isNum(t.score) ? Math.max(0, Math.round(t.score)) : 0;
    const same = [...state.teams.values()].find((x) => normName(x.name) === normName(name));
    if (same) {
      same.score = score;
      idMap.set(t.id, same.id);
    } else if (!state.teams.has(t.id)) {
      state.teams.set(t.id, { id: t.id, name, score, socketId: null });
      idMap.set(t.id, t.id);
    }
  }

  const byId = new Map(questions.map((q) => [q.id, q]));
  const order = Array.isArray(saved.questionOrder) ? saved.questionOrder : [];
  const sameCsv =
    saved.csvHash === csvHash && order.length === questions.length && new Set(order).size === order.length && order.every((id) => byId.has(id));
  if (sameCsv) {
    questions.splice(0, questions.length, ...order.map((id) => byId.get(id)));
    const qi = saved.questionIndex;
    state.questionIndex = Number.isInteger(qi) && qi >= -1 && qi < questions.length ? qi : -1;
    state.phase = ['idle', 'buzzing', 'revealed', 'finished'].includes(saved.phase) ? saved.phase : 'idle';
    if (state.questionIndex === -1) state.phase = 'idle';
    state.responses = new Map();
    for (const entry of Array.isArray(saved.responses) ? saved.responses : []) {
      if (!Array.isArray(entry) || !entry[1] || typeof entry[1] !== 'object') continue;
      const id = idMap.get(entry[0]);
      const r = entry[1];
      if (!id || state.responses.has(id) || state.responses.size >= MAX_BUZZERS) continue;
      state.responses.set(id, {
        position: state.responses.size,
        deadline: isNum(r.deadline) ? r.deadline : 0,
        answer: Number.isInteger(r.answer) && r.answer >= 0 && r.answer < 4 ? r.answer : null,
        delta: isNum(r.delta) ? r.delta : null,
      });
    }
  } else {
    console.log(`${path.basename(QUESTIONS_FILE)} mudou desde a última partida: equipes e pontos mantidos, perguntas recomeçam.`);
  }
  console.log(
    `Partida restaurada: ${state.teams.size} equipe(s)` +
      (state.questionIndex >= 0 ? `, pergunta ${state.questionIndex + 1}/${questions.length}` : '') +
      '. Use "Reiniciar Jogo" para zerar.'
  );
  return true;
}

// Restaura a partida a partir da cópia do apresentador, se fizer sentido.
function restoreFromHost(backup) {
  if (!backup || typeof backup !== 'object') return false;
  if (backup.bootId === bootId) return false; // mesmo servidor: nada se perdeu
  if (!isNum(backup.savedAt) || Date.now() - backup.savedAt > HOST_BACKUP_MAX_AGE_MS) return false;
  if (state.questionIndex !== -1) return false; // já há uma partida em andamento neste servidor
  if (!Array.isArray(backup.teams) || !backup.teams.length) return false;
  console.log('Servidor reiniciou: restaurando a partida a partir da cópia do apresentador.');
  return applySnapshot(backup);
}

try {
  applySnapshot(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
} catch {
  // sem arquivo salvo (ou corrompido): começa do zero
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    saveNow();
    process.exit(0);
  });
}

// ---------- Prazos e revelação automática ----------

// Um único timer "acorda" o servidor quando o prazo de alguém expira, só para
// atualizar as telas (o prazo em si é validado em phone:answer).
let expiryTimer = null;
function scheduleExpiryBroadcast() {
  clearTimeout(expiryTimer);
  expiryTimer = null;
  if (state.phase !== 'buzzing') return;
  const now = Date.now();
  const pending = [...state.responses.values()]
    .filter((r) => r.answer == null && r.deadline > now)
    .map((r) => r.deadline);
  if (!pending.length) return;
  expiryTimer = setTimeout(() => broadcast(), Math.min(...pending) - now + 50);
}

const slotsFull = () => state.responses.size >= MAX_BUZZERS;

// Ninguém mais pode apertar (vagas esgotadas ou todas as equipes conectadas já apertaram)
// e quem apertou já respondeu (ou o tempo acabou)?
function everyoneDone() {
  if (state.phase !== 'buzzing' || !state.responses.size) return false;
  const now = Date.now();
  const resolved = [...state.responses.values()].every((r) => r.answer != null || now > r.deadline + ANSWER_SLACK_MS);
  if (!resolved) return false;
  if (slotsFull()) return true;
  const online = [...state.teams.values()].filter(isOnline);
  return online.length > 0 && online.every((t) => state.responses.has(t.id));
}

let autoRevealTimer = null;
function cancelAutoReveal() {
  clearTimeout(autoRevealTimer);
  autoRevealTimer = null;
}
function scheduleAutoReveal() {
  if (!AUTO_REVEAL || autoRevealTimer || !everyoneDone()) return;
  const q = state.questionIndex;
  autoRevealTimer = setTimeout(() => {
    autoRevealTimer = null;
    // Confere de novo: alguém pode ter entrado ou o apresentador já revelou.
    if (state.questionIndex === q && everyoneDone()) {
      reveal();
      broadcast();
    }
  }, AUTO_REVEAL_DELAY_MS);
}

// ---------- Estado enviado às telas ----------

function responsesPayload(revealed) {
  const now = Date.now();
  return [...state.responses.entries()].map(([teamId, r]) => ({
    teamId,
    position: r.position,
    points: pointsForPosition(r.position),
    deadline: r.deadline,
    answered: r.answer != null,
    expired: r.answer == null && now > r.deadline,
    // A escolha de cada equipe só é revelada depois da revelação,
    // senão quem aperta depois poderia copiar olhando o telão.
    answer: revealed ? r.answer : undefined,
    delta: revealed ? r.delta : undefined,
  }));
}

function basePayload() {
  const q = currentQuestion();
  const revealed = state.phase === 'revealed';
  return {
    phase: state.phase,
    questionIndex: state.questionIndex,
    questionCount: questions.length,
    serverNow: Date.now(),
    answerMs: ANSWER_MS,
    nextPoints: slotsFull() ? null : pointsForPosition(state.responses.size),
    maxBuzzers: MAX_BUZZERS,
    slotsLeft: Math.max(0, MAX_BUZZERS - state.responses.size),
    autoRevealing: !!autoRevealTimer,
    responses: responsesPayload(revealed),
    teams: publicTeams(),
    question: q
      ? {
          category: q.category,
          question: q.question,
          answers: q.answers,
          // O gabarito só sai do servidor depois da revelação.
          correct: revealed ? q.correct : null,
          image: q.image,
        }
      : null,
  };
}

function payloadFor(socketId, base) {
  const team = teamForSocket(socketId);
  const r = team ? state.responses.get(team.id) : null;
  // Cada celular recebe a própria resposta (para restaurar após reconexão).
  return { ...base, mine: r ? { position: r.position, answer: r.answer, deadline: r.deadline } : null };
}

function broadcast() {
  scheduleAutoReveal();
  const base = basePayload();
  for (const [id, socket] of io.sockets.sockets) socket.emit('game', payloadFor(id, base));
  if (hostSockets.size) {
    const backup = snapshot();
    for (const id of hostSockets) io.sockets.sockets.get(id)?.emit('host:backup', backup);
  }
  scheduleExpiryBroadcast();
  saveSoon();
}

function nextQuestion() {
  if (state.questionIndex + 1 >= questions.length) return false;
  state.questionIndex += 1;
  state.phase = 'buzzing';
  state.responses.clear();
  return true;
}

function reveal() {
  cancelAutoReveal();
  const q = currentQuestion();
  if (!q || state.phase !== 'buzzing') return;
  for (const [teamId, r] of state.responses) {
    const t = state.teams.get(teamId);
    if (r.answer == null) r.delta = 0;
    else if (r.answer === q.correct) r.delta = pointsForPosition(r.position);
    else r.delta = -Math.min(PENALTY, t ? t.score : 0);
    if (t) t.score += r.delta;
  }
  state.phase = 'revealed';
}

// ---------- Eventos ----------

io.on('connection', (socket) => {
  socket.emit('game', payloadFor(socket.id, basePayload()));

  socket.on('phone:join', (name, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    if (!clean) return reply({ ok: false, error: 'Digite o nome da equipe.' });
    const existing = teamForSocket(socket.id);
    if (existing) return reply({ ok: true, teamId: existing.id, name: existing.name });

    const same = [...state.teams.values()].find((t) => normName(t.name) === normName(clean));
    if (same) {
      // Nome já usado: se aquela equipe está desconectada, este celular a assume
      // (ex.: aluno trocou de aparelho ou limpou o navegador). Se está conectada, recusa.
      if (isOnline(same)) return reply({ ok: false, error: 'Já existe uma equipe com esse nome. Escolha outro.' });
      attachSocket(same, socket);
      reply({ ok: true, teamId: same.id, name: same.name });
      return broadcast();
    }

    const team = { id: crypto.randomUUID(), name: clean, score: 0, socketId: null };
    state.teams.set(team.id, team);
    attachSocket(team, socket);
    reply({ ok: true, teamId: team.id, name: clean });
    broadcast();
  });

  socket.on('phone:restore', (teamId, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const team = typeof teamId === 'string' ? state.teams.get(teamId) : null;
    if (!team) return reply({ ok: false });
    attachSocket(team, socket);
    reply({ ok: true, name: team.name, score: team.score });
    broadcast();
  });

  socket.on('phone:buzz', () => {
    if (state.phase !== 'buzzing') return;
    const team = teamForSocket(socket.id);
    if (!team || state.responses.has(team.id) || slotsFull()) return;
    state.responses.set(team.id, {
      position: state.responses.size,
      deadline: Date.now() + ANSWER_MS,
      answer: null,
      delta: null,
    });
    broadcast();
  });

  socket.on('phone:answer', (idx) => {
    if (state.phase !== 'buzzing') return;
    const team = teamForSocket(socket.id);
    const r = team && state.responses.get(team.id);
    if (!r || r.answer != null) return;
    if (Date.now() > r.deadline + ANSWER_SLACK_MS) return;
    const q = currentQuestion();
    if (!q || !Number.isInteger(idx) || idx < 0 || idx >= q.answers.length || !q.answers[idx]) return;
    r.answer = idx;
    broadcast();
  });

  // A tela do apresentador se identifica e envia a cópia que tem guardada.
  socket.on('host:hello', (backup, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    hostSockets.add(socket.id);
    const restored = restoreFromHost(backup);
    reply({ restored, savedAt: restored ? backup.savedAt : null });
    broadcast();
  });

  socket.on('host:start', () => {
    // Só avança depois de revelar (ou a partir da tela inicial).
    if (state.phase !== 'idle' && state.phase !== 'revealed') return;
    if (nextQuestion()) return broadcast();
    if (questions.length > 0) {
      state.phase = 'finished';
      broadcast();
    }
  });

  socket.on('host:confirm', () => {
    if (state.phase !== 'buzzing') return;
    reveal();
    broadcast();
  });

  socket.on('host:removeTeam', (teamId) => {
    const team = typeof teamId === 'string' ? state.teams.get(teamId) : null;
    if (!team) return;
    state.teams.delete(team.id);
    state.responses.delete(team.id);
    if (team.socketId) {
      state.socketTeams.delete(team.socketId);
      const s = io.sockets.sockets.get(team.socketId);
      if (s) s.emit('phone:removed');
    }
    broadcast();
  });

  socket.on('host:restart', () => {
    cancelAutoReveal();
    state.questionIndex = -1;
    state.phase = 'idle';
    state.responses.clear();
    for (const team of state.teams.values()) team.score = 0;
    // nova partida = nova ordem de perguntas
    shuffle(questions);
    broadcast();
  });

  socket.on('disconnect', () => {
    hostSockets.delete(socket.id);
    const teamId = state.socketTeams.get(socket.id);
    if (!teamId) return;
    state.socketTeams.delete(socket.id);
    const team = state.teams.get(teamId);
    if (team && team.socketId === socket.id) team.socketId = null;
    // A equipe e sua resposta são mantidas; se voltar dentro do prazo, ainda pode responder.
    broadcast();
  });
});

const listenPort = process.env.PORT || 3000;
server.listen(listenPort, () => {
  console.log(`Revisão! rodando:`);
  console.log(`  Tela do apresentador: http://localhost:${listenPort}/host`);
  console.log(`  Celulares:            http://localhost:${listenPort}/`);
});
