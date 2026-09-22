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

const rawRows = parseCSV(fs.readFileSync(path.join(__dirname, 'questions.csv'), 'utf8').replace(/^\uFEFF/, ''));
const questions = rawRows.slice(1).map((r) => ({
  category: r[0] || 'Geral',
  question: r[1],
  answers: [r[2], r[3], r[4], r[5]],
  correct: Number(r[6]),
  image: (r[7] || '').trim() || null,
}));

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

const POINTS = 100;
const PENALTY = 20;
const GRACE_MS = 300000;
const ANSWER_MS = 5000;

const state = {
  teams: new Map(),
  socketTeams: new Map(),
  questionIndex: -1,
  phase: 'idle',
  pickedTeam: null,
  answerChosen: null,
  buzzQueue: [],
  answerDeadline: null,
  answerTimer: null,
  chanced: new Set(),
};

const currentQuestion = () =>
  state.questionIndex >= 0 && state.questionIndex < questions.length
    ? questions[state.questionIndex]
    : null;

const publicTeams = () =>
  Array.from(state.teams.entries()).map(([id, t]) => ({
    id,
    name: t.name,
    score: t.score,
    online: !!(t.socketId && io.sockets.sockets.get(t.socketId)),
  }));

function teamForSocket(socketId) {
  const teamId = state.socketTeams.get(socketId);
  return teamId ? state.teams.get(teamId) || null : null;
}

function stopGrace(team) {
  clearTimeout(team.graceTimer);
  team.graceTimer = null;
}

function startGrace(team) {
  if (team.graceTimer) return;
  team.socketId = null;
  team.graceTimer = setTimeout(() => {
    team.graceTimer = null;
    if (state.teams.delete(team.id)) broadcast();
  }, GRACE_MS);
}

function clearAnswerTimer() {
  clearTimeout(state.answerTimer);
  state.answerTimer = null;
  state.answerDeadline = null;
}

function giveFloorTo(teamId) {
  state.pickedTeam = teamId;
  state.chanced.add(teamId);
  state.answerChosen = null;
  state.phase = 'answering';
  state.answerDeadline = Date.now() + ANSWER_MS;
  state.answerTimer = setTimeout(passFloorToNext, ANSWER_MS);
}

function passFloorToNext() {
  clearAnswerTimer();
  const idx = state.buzzQueue.indexOf(state.pickedTeam);
  if (idx !== -1) state.buzzQueue.splice(idx, 1);
  if (state.buzzQueue.length) {
    giveFloorTo(state.buzzQueue[0]);
  } else {
    state.pickedTeam = null;
    state.answerChosen = null;
    state.phase = 'buzzing';
  }
  broadcast();
}

function statePayload() {
  const q = currentQuestion();
  return {
    phase: state.phase,
    questionIndex: state.questionIndex,
    questionCount: questions.length,
    pickedTeam: state.pickedTeam,
    answerChosen: state.answerChosen,
    buzzQueue: state.buzzQueue,
    answerEndsAt: state.answerDeadline,
    teams: publicTeams(),
    question: q
      ? {
          category: q.category,
          question: q.question,
          answers: q.answers,
          correct: q.correct,
          image: q.image,
        }
      : null,
  };
}

function broadcast() {
  io.emit('game', statePayload());
}

function nextQuestion() {
  if (state.questionIndex + 1 >= questions.length) return false;
  state.questionIndex += 1;
  state.phase = 'buzzing';
  state.pickedTeam = null;
  state.answerChosen = null;
  state.buzzQueue = [];
  state.chanced.clear();
  clearAnswerTimer();
  return true;
}

io.on('connection', (socket) => {
  socket.emit('game', statePayload());

  socket.on('phone:join', (name, cb) => {
    const clean = String(name || '').trim().slice(0, 30);
    if (!clean) return cb && cb({ ok: false });
    const existing = teamForSocket(socket.id);
    if (existing) {
      stopGrace(existing);
      return cb && cb({ ok: true, teamId: existing.id, name: existing.name });
    }
    const teamId = crypto.randomUUID();
    const team = {
      id: teamId,
      name: clean,
      score: 0,
      socketId: socket.id,
      graceTimer: null,
    };
    state.teams.set(teamId, team);
    state.socketTeams.set(socket.id, teamId);
    cb && cb({ ok: true, teamId, name: clean });
    broadcast();
  });

  socket.on('phone:restore', (teamId, cb) => {
    if (typeof teamId !== 'string') return cb && cb({ ok: false });
    const team = state.teams.get(teamId);
    if (!team) return cb && cb({ ok: false });
    stopGrace(team);
    team.socketId = socket.id;
    state.socketTeams.set(socket.id, teamId);
    cb && cb({ ok: true, name: team.name, score: team.score });
    broadcast();
  });

  socket.on('phone:buzz', () => {
    if (state.phase !== 'buzzing' && state.phase !== 'answering') return;
    const team = teamForSocket(socket.id);
    if (!team || state.chanced.has(team.id) || state.buzzQueue.includes(team.id)) return;
    state.buzzQueue.push(team.id);
    if (state.phase === 'buzzing') giveFloorTo(team.id);
    broadcast();
  });

  socket.on('phone:answer', (idx) => {
    if (state.phase !== 'answering') return;
    const team = teamForSocket(socket.id);
    if (!team || state.pickedTeam !== team.id) return;
    const q = currentQuestion();
    if (!q || typeof idx !== 'number' || idx < 0 || idx >= q.answers.length) return;
    state.answerChosen = idx;
    clearAnswerTimer();
    broadcast();
  });

  socket.on('host:start', () => {
    if (nextQuestion()) return broadcast();
    if (state.questionIndex >= 0 && state.questionIndex >= questions.length - 1 && questions.length > 0) {
      clearAnswerTimer();
      state.phase = 'finished';
      broadcast();
    }
  });

  socket.on('host:confirm', () => {
    if (state.phase !== 'answering') return;
    clearAnswerTimer();
    const q = currentQuestion();
    const t = state.pickedTeam ? state.teams.get(state.pickedTeam) : null;
    if (q && t && state.answerChosen === q.correct) t.score += POINTS;
    else if (q && t && state.answerChosen != null) t.score = Math.max(0, t.score - PENALTY);
    state.phase = 'revealed';
    state.buzzQueue = [];
    broadcast();
  });

  socket.on('host:restart', () => {
    clearAnswerTimer();
    state.questionIndex = -1;
    state.phase = 'idle';
    state.pickedTeam = null;
    state.answerChosen = null;
    state.buzzQueue = [];
    state.chanced.clear();
    for (const team of state.teams.values()) team.score = 0;
    broadcast();
  });

  socket.on('disconnect', () => {
    const teamId = state.socketTeams.get(socket.id);
    if (!teamId) return;
    state.socketTeams.delete(socket.id);
    const team = state.teams.get(teamId);
    if (!team) return;
    if (state.pickedTeam === teamId && state.phase === 'answering') passFloorToNext();
    state.buzzQueue = state.buzzQueue.filter((id) => id !== teamId);
    broadcast();
    startGrace(team);
  });
});

const listenPort = process.env.PORT || 3000;
server.listen(listenPort, () => {
  console.log(`Revisão! rodando:`);
  console.log(`  Tela do apresentador: http://localhost:${listenPort}/host`);
  console.log(`  Celulares:            http://localhost:${listenPort}/`);
});
