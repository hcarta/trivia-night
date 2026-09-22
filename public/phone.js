const socket = io();
let meId = null;
let joined = false;
let lastGame = null;
let countdownInterval = null;

const $ = (id) => document.getElementById(id);
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const STORE_KEY = 'trivia-night-team';

const screens = ['screen-join', 'screen-waiting', 'screen-buzz', 'screen-answer', 'screen-result', 'screen-finished'];

function show(id) {
  screens.forEach((s) => $(s).classList.toggle('active', s === id));
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSaved() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {}
}

function saveMe(teamId, name) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ id: teamId, name }));
  } catch {}
}

function onJoined(teamId, name) {
  meId = teamId;
  joined = true;
  saveMe(teamId, name);
  $('phone-name').textContent = name;
  if (lastGame) render(lastGame);
}

function tryRestore() {
  const saved = loadSaved();
  if (!saved || !saved.id) return;
  socket.emit('phone:restore', saved.id, (res) => {
    if (res && res.ok) {
      onJoined(saved.id, res.name);
    } else {
      clearSaved();
      $('join-name').value = saved.name || '';
      $('phone-name').textContent = 'Entre no jogo';
    }
  });
}

function tryJoin() {
  const name = $('join-name').value;
  if (!name.trim()) return;
  $('join-btn').disabled = true;
  socket.emit('phone:join', name, (res) => {
    $('join-btn').disabled = false;
    if (res && res.ok) onJoined(res.teamId, res.name);
  });
}

socket.on('connect', tryRestore);

$('join-btn').onclick = tryJoin;
$('join-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tryJoin();
});

$('buzz-btn').onclick = () => {
  if ($('buzz-btn').classList.contains('disabled')) return;
  $('buzz-btn').classList.add('disabled');
  socket.emit('phone:buzz');
};

document.querySelectorAll('.answer-btn').forEach((btn) => {
  btn.onclick = () => {
    if (btn.classList.contains('disabled')) return;
    btn.classList.add('disabled', 'chosen');
    $('answer-status').textContent = 'Travado!';
    socket.emit('phone:answer', Number(btn.dataset.idx));
  };
});

function startCountdown(game) {
  clearCountdown();
  if (!game.answerEndsAt) return;
  function tick() {
    const left = Math.max(0, Math.ceil((game.answerEndsAt - Date.now()) / 1000));
    $('answer-timer').textContent = left;
    $('answer-timer').classList.toggle('urgent', left <= 3);
    if (left <= 0) {
      clearCountdown();
      return;
    }
  }
  tick();
  countdownInterval = setInterval(tick, 200);
}

function clearCountdown() {
  clearInterval(countdownInterval);
  countdownInterval = null;
  if ($('answer-timer')) $('answer-timer').textContent = '';
}

function render(game) {
  lastGame = game;
  if (!joined) return;

  const me = game.teams.find((t) => t.id === meId);
  $('phone-score').textContent = me ? me.score : 0;

  if (!game.question) {
    show('screen-waiting');
    return;
  }

  switch (game.phase) {
    case 'buzzing': {
      clearCountdown();
      $('buzz-btn').classList.remove('disabled');
      $('buzz-position').textContent = '';
      show('screen-buzz');
      break;
    }
    case 'answering': {
      const queuePos = game.buzzQueue.indexOf(meId);
      if (game.pickedTeam === meId) {
        clearCountdown();
        startCountdown(game);
        const locked = game.answerChosen != null;
        const pimg = $('phone-q-img');
        if (game.question.image) {
          pimg.src = game.question.image;
          pimg.classList.remove('hidden');
        } else {
          pimg.removeAttribute('src');
          pimg.classList.add('hidden');
        }
        document.querySelectorAll('.answer-btn').forEach((b) => {
          const idx = Number(b.dataset.idx);
          b.querySelector('.btn-text').textContent = game.question.answers[idx] || '';
          b.classList.toggle('chosen', idx === game.answerChosen);
          if (locked) b.classList.add('disabled');
          else b.classList.remove('disabled');
        });
        $('answer-status').textContent = locked ? 'Travado!' : 'Escolha sua resposta!';
        show('screen-answer');
      } else if (queuePos !== -1) {
        clearCountdown();
        $('buzz-position').textContent = `#${queuePos + 1} na fila — aguarde…`;
        $('buzz-btn').classList.add('disabled');
        show('screen-buzz');
      } else {
        clearCountdown();
        $('buzz-position').textContent = '';
        $('buzz-btn').classList.remove('disabled');
        show('screen-buzz');
      }
      break;
    }
    case 'revealed': {
      clearCountdown();
      const correct = game.question.correct;
      if (game.pickedTeam === meId) {
        const right = game.answerChosen === correct;
        $('result-text').textContent = right ? 'CORRETO! +100' : 'Resposta errada!';
        $('result-text').className = 'result-text ' + (right ? 'ok-text' : 'no-text');
      } else {
        $('result-text').textContent = `A resposta era ${LETTERS[correct]}`;
        $('result-text').className = 'result-text';
      }
      show('screen-result');
      break;
    }
    case 'finished': {
      clearCountdown();
      show('screen-finished');
      break;
    }
    default:
      clearCountdown();
      show('screen-waiting');
  }
}

socket.on('game', render);
