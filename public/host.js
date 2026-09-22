const socket = io();

const els = {
  welcome: document.getElementById('welcome'),
  qrImg: document.getElementById('qr-img'),
  joinUrl: document.getElementById('join-url'),
  welcomeStartBtn: document.getElementById('welcome-start-btn'),
  welcomeTeams: document.getElementById('welcome-teams'),
  grid: document.getElementById('game-grid'),
  phase: document.getElementById('phase-badge'),
  qimg: document.getElementById('q-img'),
  question: document.getElementById('question-text'),
  answers: document.getElementById('answers'),
  reveal: document.getElementById('reveal-box'),
  status: document.getElementById('game-status'),
  buzzQueue: document.getElementById('buzz-queue'),
  scoreboard: document.getElementById('scoreboard'),
  progress: document.getElementById('progress'),
  countdown: document.getElementById('answer-countdown'),
  startBtn: document.getElementById('start-btn'),
  confirmBtn: document.getElementById('confirm-btn'),
  resultsBtn: document.getElementById('results-btn'),
  restartBtn: document.getElementById('restart-btn'),
  resultsOverlay: document.getElementById('results-overlay'),
  rankingList: document.getElementById('ranking-list'),
  closeResults: document.getElementById('close-results'),
};

els.startBtn.onclick = () => socket.emit('host:start');
els.welcomeStartBtn.onclick = () => socket.emit('host:start');
els.confirmBtn.onclick = () => socket.emit('host:confirm');
els.restartBtn.onclick = () => {
  if (confirm('Reiniciar a Revisão!?\nAs pontuações voltam a 0 e você volta para a tela de boas-vindas. As equipes permanecem conectadas.')) {
    socket.emit('host:restart');
  }
};
els.resultsBtn.onclick = () => {
  els.resultsOverlay.classList.remove('hidden');
};
els.closeResults.onclick = () => {
  els.resultsOverlay.classList.add('hidden');
};

fetch('/config')
  .then((r) => r.json())
  .then((cfg) => {
    els.qrImg.src = cfg.qrDataUrl;
    els.joinUrl.textContent = cfg.joinUrl;
  });

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

// Rótulos em português para as fases exibidas no badge do apresentador.
const PHASE_LABELS = {
  idle: 'AGUARDANDO',
  buzzing: 'EM DISPUTA',
  answering: 'RESPONDENDO',
  revealed: 'RESPOSTA REVELADA',
  finished: 'FIM DE JOGO',
};

function esc(s) {
  const div = document.createElement('div');
  div.textContent = String(s ?? '');
  return div.innerHTML;
}

let countdownInterval = null;

function startHostCountdown(answerEndsAt) {
  clearHostCountdown();
  if (!answerEndsAt) return;
  function tick() {
    const left = Math.max(0, Math.ceil((answerEndsAt - Date.now()) / 1000));
    els.countdown.textContent = left + 's';
    els.countdown.classList.toggle('urgent', left <= 3);
    if (left <= 0) clearHostCountdown();
  }
  tick();
  countdownInterval = setInterval(tick, 200);
}

function clearHostCountdown() {
  clearInterval(countdownInterval);
  countdownInterval = null;
  els.countdown.textContent = '';
}

function renderRanking(teams) {
  const sorted = [...teams].sort((a, b) => b.score - a.score);
  els.rankingList.innerHTML = sorted
    .map((t, i) => {
      let cls = 'rank-item';
      if (i === 0) cls += ' gold';
      else if (i === 1) cls += ' silver';
      else if (i === 2) cls += ' bronze';
      return `<li class="${cls}"><span class="rank-pos">${i + 1}</span><span class="rank-name">${esc(t.name)}</span><span class="rank-score">${t.score}</span></li>`;
    })
    .join('');
}

function render(game) {
  const isWelcome = game.questionIndex === -1;
  els.welcome.classList.toggle('hidden', !isWelcome);
  els.grid.classList.toggle('hidden', isWelcome);

  const sorted = [...game.teams].sort((a, b) => b.score - a.score);
  els.scoreboard.innerHTML = sorted.length
    ? sorted
        .map(
          (t, i) => `
          <div class="team-chip ${game.pickedTeam === t.id ? 'picked' : ''} ${t.online ? '' : 'offline'}">
            <span class="rank">${i + 1}</span>
            <span class="tname">${esc(t.name)}</span>
            <span class="tscore">${t.score}</span>
            ${t.online ? '' : '<span class="offline-tag">desconectada</span>'}
          </div>`
        )
        .join('')
    : '<div class="hint">Aguardando equipes se juntarem…</div>';

  if (isWelcome) {
    els.welcomeTeams.innerHTML = game.teams.length
      ? game.teams
          .map(
            (t) =>
              `<div class="team-line ${t.online ? '' : 'offline'}">${esc(t.name)}${t.online ? '' : ' <span class="offline-tag">desconectada</span>'}</div>`
          )
          .join('')
      : '<div class="hint">Aguardando equipes — escaneie o QR code para participar</div>';
    els.startBtn.textContent = game.teams.length
      ? `Iniciar Jogo (${game.teams.length} equipe${game.teams.length > 1 ? 's' : ''})`
      : 'Iniciar Jogo';
    return;
  }

  const { question } = game;
  const picked = game.teams.find((t) => t.id === game.pickedTeam);

  els.progress.textContent =
    game.questionIndex >= 0
      ? `Pergunta ${game.questionIndex + 1} / ${game.questionCount}`
      : '';

  if (!question) {
    els.question.textContent = 'Pressione "Próxima Pergunta" para começar';
    els.qimg.classList.add('hidden');
    els.answers.innerHTML = '';
    els.reveal.classList.add('hidden');
    els.status.innerHTML = '<div class="hint">Aguardando iniciar</div>';
    els.buzzQueue.innerHTML = '';
    clearHostCountdown();
    els.countdown.classList.add('hidden');
    els.confirmBtn.classList.add('hidden');
    els.resultsBtn.classList.add('hidden');
    els.startBtn.classList.remove('hidden');
    els.startBtn.textContent = 'Próxima Pergunta';
    return;
  }

  els.phase.textContent = `${(question.category || 'Geral').toUpperCase()} · ${PHASE_LABELS[game.phase] || String(game.phase).toUpperCase()}`;
  els.question.textContent = question.question;
  if (question.image) {
    els.qimg.src = question.image;
    els.qimg.classList.remove('hidden');
  } else {
    els.qimg.removeAttribute('src');
    els.qimg.classList.add('hidden');
  }

  els.answers.innerHTML = question.answers
    .map((a, i) => {
      let cls = 'answer-item';
      if (game.phase === 'revealed') {
        if (i === question.correct) cls += ' correct';
        else if (i === game.answerChosen) cls += ' wrong';
      } else if (i === game.answerChosen) {
        cls += ' chosen';
      }
      return `<li class="${cls}"><span class="letter">${LETTERS[i]}</span><span>${esc(a)}</span></li>`;
    })
    .join('');

  if (game.phase === 'revealed') {
    els.reveal.classList.remove('hidden');
    if (game.answerChosen != null) {
      const right = game.answerChosen === question.correct;
      els.reveal.innerHTML = `<strong>${esc(picked ? picked.name : 'Equipe')}</strong> escolheu <strong>${LETTERS[game.answerChosen]}</strong> — ${
        right ? 'CORRETO! +100' : 'Resposta errada'
      } · Correto: ${LETTERS[question.correct]}`;
      els.reveal.className = 'reveal ' + (right ? 'ok-box' : 'no-box');
    } else {
      els.reveal.innerHTML = 'Nenhuma resposta foi dada.';
      els.reveal.className = 'reveal';
    }
  } else {
    els.reveal.classList.add('hidden');
  }

  clearHostCountdown();
  els.countdown.classList.toggle('hidden', game.phase !== 'answering');
  if (game.phase === 'answering' && game.answerEndsAt && !game.answerChosen) {
    startHostCountdown(game.answerEndsAt);
  }

  const pickedName = picked ? picked.name : 'Equipe';
  if (game.phase === 'buzzing') {
    els.status.innerHTML = '<div class="hint">Aguardando uma equipe apertar…</div>';
    els.buzzQueue.innerHTML = '';
  } else if (game.phase === 'answering') {
    els.status.innerHTML = `<div class="hint"><strong>${esc(pickedName)}</strong> está respondendo…${
      game.answerChosen != null ? ` escolheu ${LETTERS[game.answerChosen]}` : ''
    }</div>`;
    if (game.buzzQueue.length > 1) {
      els.buzzQueue.innerHTML = game.buzzQueue
        .slice(1)
        .map((tid, i) => {
          const t = game.teams.find((t) => t.id === tid);
          return `<div class="queue-item">#${i + 2} — ${esc(t ? t.name : 'Equipe')}</div>`;
        })
        .join('');
    } else {
      els.buzzQueue.innerHTML = '';
    }
  } else if (game.phase === 'revealed') {
    els.status.innerHTML = '<div class="hint">Resposta confirmada</div>';
    els.buzzQueue.innerHTML = '';
  } else if (game.phase === 'finished') {
    els.status.innerHTML = '<div class="hint">Todas as perguntas respondidas!</div>';
    els.buzzQueue.innerHTML = '';
  } else {
    els.status.innerHTML = '<div class="hint">Aguardando iniciar</div>';
    els.buzzQueue.innerHTML = '';
  }

  els.confirmBtn.classList.toggle('hidden', game.phase !== 'answering');
  els.resultsBtn.classList.toggle('hidden', game.phase !== 'finished');

  const hasMore = game.questionIndex + 1 < game.questionCount;
  if (game.phase === 'finished') {
    els.startBtn.classList.add('hidden');
  } else if (game.phase === 'answering') {
    els.startBtn.classList.add('hidden');
  } else {
    els.startBtn.classList.remove('hidden');
    els.startBtn.textContent = hasMore ? 'Próxima Pergunta' : 'Finalizar';
  }

  renderRanking(game.teams);
}

socket.on('game', render);
