const socket = io();
let meId = null;
let joined = false;
let lastGame = null;
let countdownInterval = null;
let localAnswer = null;

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
  clearTimeout(restoreTimer);
  restoreGen += 1; // descarta respostas de tentativas de reconexão em andamento
  meId = teamId;
  joined = true;
  saveMe(teamId, name);
  $('phone-name').textContent = name;
  if (lastGame) render(lastGame);
}

// Se o servidor reiniciou, a equipe só volta a existir depois que o apresentador
// abrir a tela /host (que devolve a partida). Por isso, em caso de falha, o celular
// continua tentando por alguns minutos, sem esquecer a equipe.
const RESTORE_RETRY_MS = 3000;
const RESTORE_GIVE_UP_MS = 5 * 60 * 1000;
let restoreTimer = null;
let restoreStartedAt = 0;
let restoreGen = 0;

function tryRestore() {
  const saved = loadSaved();
  if (!saved || !saved.id) return;
  if (!restoreStartedAt) restoreStartedAt = Date.now();
  clearTimeout(restoreTimer);
  const gen = restoreGen;
  socket.emit('phone:restore', saved.id, (res) => {
    if (gen !== restoreGen) return; // entrou manualmente enquanto isso
    if (res && res.ok) {
      restoreStartedAt = 0;
      $('join-error').textContent = '';
      onJoined(saved.id, res.name);
      return;
    }
    // O servidor não conhece mais esta equipe (provavelmente reiniciou).
    joined = false;
    meId = null;
    clearCountdown();
    show('screen-join');
    if (!$('join-name').value) $('join-name').value = saved.name || '';
    $('phone-name').textContent = 'Entre no jogo';
    if (Date.now() - restoreStartedAt < RESTORE_GIVE_UP_MS) {
      $('join-error').textContent = `Reconectando à equipe "${saved.name}"… ou toque em Entrar.`;
      restoreTimer = setTimeout(tryRestore, RESTORE_RETRY_MS);
    } else {
      clearSaved();
      restoreStartedAt = 0;
      $('join-error').textContent = '';
    }
  });
}

function tryJoin() {
  const name = $('join-name').value;
  if (!name.trim()) return;
  $('join-btn').disabled = true;
  socket.emit('phone:join', name, (res) => {
    $('join-btn').disabled = false;
    if (res && res.ok) {
      $('join-error').textContent = '';
      onJoined(res.teamId, res.name);
    } else {
      $('join-error').textContent = (res && res.error) || 'Não foi possível entrar. Tente de novo.';
    }
  });
}

// O apresentador removeu esta equipe: volta para a tela de entrada.
socket.on('phone:removed', () => {
  clearSaved();
  meId = null;
  joined = false;
  localAnswer = null;
  clearCountdown();
  $('phone-name').textContent = 'Entre no jogo';
  $('phone-score').textContent = '0';
  $('join-error').textContent = 'Sua equipe foi removida pelo apresentador.';
  show('screen-join');
});

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
    const idx = Number(btn.dataset.idx);
    document.querySelectorAll('.answer-btn').forEach((b) => b.classList.add('disabled'));
    btn.classList.add('chosen');
    $('answer-status').textContent = 'Travado!';
    localAnswer = { q: lastGame ? lastGame.questionIndex : -1, idx };
    socket.emit('phone:answer', idx);
  };
});

// Diferença entre o relógio do servidor e o do celular, para o prazo de resposta.
let clockOffset = 0;
let countdownDeadline = null;

function startCountdown(deadline) {
  if (countdownInterval && countdownDeadline === deadline) return;
  clearCountdown();
  countdownDeadline = deadline;
  function tick() {
    const left = Math.max(0, Math.ceil((deadline - (Date.now() + clockOffset)) / 1000));
    $('answer-timer').textContent = left;
    $('answer-timer').classList.toggle('urgent', left <= 3);
    if (left <= 0) {
      clearCountdown();
      // Tempo acabou: trava os botões localmente (o servidor também recusa).
      document.querySelectorAll('.answer-btn').forEach((b) => b.classList.add('disabled'));
      $('answer-status').textContent = 'Tempo esgotado!';
    }
  }
  tick();
  countdownInterval = setInterval(tick, 200);
}

function clearCountdown() {
  clearInterval(countdownInterval);
  countdownInterval = null;
  countdownDeadline = null;
  $('answer-timer').textContent = '';
  $('answer-timer').classList.remove('urgent');
}

function setResult(text, kind, sub) {
  $('result-text').textContent = text;
  $('result-text').className = 'result-text' + (kind ? ' ' + kind : '');
  $('result-sub').textContent = sub || '';
  show('screen-result');
}

const ordinal = (pos) => `${pos + 1}º`;

function render(game) {
  lastGame = game;
  clockOffset = game.serverNow - Date.now();
  if (!joined) return;

  const me = game.teams.find((t) => t.id === meId);
  $('phone-score').textContent = me ? me.score : 0;

  if (game.phase === 'finished') {
    clearCountdown();
    const sorted = [...game.teams].sort((a, b) => b.score - a.score);
    const pos = sorted.findIndex((t) => t.id === meId);
    $('finished-sub').textContent = pos >= 0 ? `Você terminou em ${pos + 1}º lugar com ${sorted[pos].score} pts` : '';
    show('screen-finished');
    return;
  }

  if (!game.question) {
    clearCountdown();
    show('screen-waiting');
    return;
  }

  const mine = game.mine;
  // Resposta já enviada mas ainda não confirmada pelo servidor.
  if (mine && mine.answer == null && localAnswer && localAnswer.q === game.questionIndex) mine.answer = localAnswer.idx;

  if (game.phase === 'buzzing') {
    if (!mine) {
      clearCountdown();
      if (!game.slotsLeft) {
        $('waiting-text').textContent = `As ${game.maxBuzzers} vagas desta pergunta já foram preenchidas. Seja mais rápido na próxima!`;
        show('screen-waiting');
        return;
      }
      $('buzz-btn').classList.remove('disabled');
      $('buzz-position').textContent = `Vale ${game.nextPoints} pts · ${game.slotsLeft === 1 ? 'resta 1 vaga' : `restam ${game.slotsLeft} vagas`}`;
      show('screen-buzz');
      return;
    }

    const pts = game.responses.find((r) => r.teamId === meId)?.points;
    const expired = mine.answer == null && Date.now() + clockOffset > mine.deadline;
    if (mine.answer != null || expired) {
      clearCountdown();
      $('waiting-text').textContent =
        mine.answer != null
          ? `Resposta ${LETTERS[mine.answer]} travada! Aguarde a revelação…`
          : 'Tempo esgotado. Aguarde a revelação…';
      show('screen-waiting');
      return;
    }

    const pimg = $('phone-q-img');
    if (game.question.image) {
      if (pimg.getAttribute('src') !== game.question.image) pimg.src = game.question.image;
      pimg.classList.remove('hidden');
    } else {
      pimg.removeAttribute('src');
      pimg.classList.add('hidden');
    }
    document.querySelectorAll('.answer-btn').forEach((b) => {
      const idx = Number(b.dataset.idx);
      const text = game.question.answers[idx];
      b.classList.toggle('hidden', !text);
      b.querySelector('.btn-text').textContent = text || '';
      b.classList.remove('chosen', 'disabled');
    });
    $('answer-status').textContent = `Você foi o ${ordinal(mine.position)} — vale ${pts} pts`;
    show('screen-answer');
    startCountdown(mine.deadline);
    return;
  }

  clearCountdown();

  if (game.phase === 'revealed') {
    const correct = game.question.correct;
    const r = game.responses.find((r) => r.teamId === meId);
    const answerLine = `A resposta era ${LETTERS[correct]}: ${game.question.answers[correct]}`;
    if (!r) setResult(`Resposta: ${LETTERS[correct]}`, '', 'Você não apertou nesta pergunta');
    else if (r.answer == null) setResult('Sem resposta', 'no-text', answerLine);
    else if (r.answer === correct) setResult(`CORRETO! +${r.delta}`, 'ok-text', `Você foi o ${ordinal(r.position)} a apertar`);
    else setResult(r.delta ? `Errou! −${-r.delta}` : 'Errou!', 'no-text', answerLine);
    return;
  }

  $('waiting-text').textContent = 'Aguardando o apresentador iniciar…';
  show('screen-waiting');
}

socket.on('game', render);
