const socket = io();

const els = {
  welcome: document.getElementById('welcome'),
  qrImg: document.getElementById('qr-img'),
  joinUrl: document.getElementById('join-url'),
  welcomeStartBtn: document.getElementById('welcome-start-btn'),
  welcomeTeams: document.getElementById('welcome-teams'),
  setSelect: document.getElementById('set-select'),
  setInfo: document.getElementById('set-info'),
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

// Diferença entre o relógio do servidor e o deste navegador, para os prazos.
let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;

let tickInterval = null;
let lastGame = null;
let resultsShownFor = false;

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

function removeBtn(t) {
  return `<button class="remove-team" data-team="${esc(t.id)}" data-name="${esc(t.name)}" title="Remover equipe" aria-label="Remover ${esc(t.name)}">×</button>`;
}

// Remover equipe (botão × no placar e na lista de boas-vindas).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.remove-team');
  if (!btn) return;
  if (confirm(`Remover a equipe "${btn.dataset.name}"?\nOs pontos dela serão perdidos.`)) {
    socket.emit('host:removeTeam', btn.dataset.team);
  }
});

function signed(n) {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
}

// Lista de equipes que apertaram, na ordem.
function renderResponses(game) {
  const revealed = game.phase === 'revealed';
  const now = serverNow();
  let anyPending = false;
  const html = game.responses
    .map((r) => {
      const t = game.teams.find((t) => t.id === r.teamId);
      const name = esc(t ? t.name : 'Equipe');
      let status;
      let cls = 'resp-item';
      if (revealed) {
        if (r.answer == null) {
          status = 'sem resposta';
          cls += ' none';
        } else {
          const right = r.answer === game.question.correct;
          cls += right ? ' ok' : ' no';
          status = `${LETTERS[r.answer]} · ${signed(r.delta)}`;
        }
      } else if (r.answered) {
        status = 'respondeu ✓';
        cls += ' done';
      } else {
        const left = Math.ceil((r.deadline - now) / 1000);
        if (left > 0) {
          anyPending = true;
          status = `${left}s`;
          cls += left <= 3 ? ' urgent' : ' waiting';
        } else {
          status = 'tempo esgotado';
          cls += ' none';
        }
      }
      return `<div class="${cls}">
        <span class="resp-pos">${r.position + 1}º</span>
        <span class="resp-name">${name}${t && !t.online ? ' <span class="offline-tag">desconectada</span>' : ''}${
          revealed ? '' : `<span class="resp-pts">vale ${r.points} pts</span>`
        }</span>
        <span class="resp-status">${status}</span>
      </div>`;
    })
    .join('');
  els.buzzQueue.innerHTML = html;
  return anyPending;
}

function renderStatus(game) {
  if (game.phase === 'buzzing') {
    const n = game.responses.length;
    const answered = game.responses.filter((r) => r.answered).length;
    const parts = [];
    parts.push(`Vagas: <strong>${n}</strong> de ${game.maxBuzzers} preenchida${n === 1 ? '' : 's'}`);
    if (n) parts.push(`<strong>${answered}</strong> de ${n} já respondeu${answered === 1 ? '' : 'ram'}`);
    if (game.autoRevealing) parts.push('<strong>Todos responderam — revelando…</strong>');
    else if (game.slotsLeft) parts.push(`Próxima a apertar vale <strong>${game.nextPoints}</strong> pts`);
    else parts.push('Vagas esgotadas');
    els.status.innerHTML = parts.map((p) => `<div class="hint">${p}</div>`).join('');
  } else if (game.phase === 'revealed') {
    const hits = game.responses.filter((r) => r.answer === game.question.correct).length;
    els.status.innerHTML = `<div class="hint">${hits} acerto${hits === 1 ? '' : 's'} de ${game.responses.length} que apertaram</div>`;
  } else if (game.phase === 'finished') {
    els.status.innerHTML = '<div class="hint">Todas as perguntas respondidas!</div>';
  } else {
    els.status.innerHTML = '<div class="hint">Aguardando iniciar</div>';
  }
}

// Atualiza só os contadores, sem esperar por uma nova mensagem do servidor.
function tick() {
  if (!lastGame || lastGame.phase !== 'buzzing') return;
  if (!renderResponses(lastGame)) stopTick();
}
function startTick() {
  if (!tickInterval) tickInterval = setInterval(tick, 250);
}
function stopTick() {
  clearInterval(tickInterval);
  tickInterval = null;
}

function render(game) {
  lastGame = game;
  clockOffset = game.serverNow - Date.now();
  const isWelcome = game.questionIndex === -1;
  els.welcome.classList.toggle('hidden', !isWelcome);
  els.grid.classList.toggle('hidden', isWelcome);

  const sorted = [...game.teams].sort((a, b) => b.score - a.score);
  const buzzed = new Set(game.responses.map((r) => r.teamId));
  els.scoreboard.innerHTML = sorted.length
    ? sorted
        .map(
          (t, i) => `
          <div class="team-chip ${game.phase === 'buzzing' && buzzed.has(t.id) ? 'picked' : ''} ${t.online ? '' : 'offline'}">
            <span class="rank">${i + 1}</span>
            <span class="tname">${esc(t.name)}</span>
            <span class="tscore">${t.score}</span>
            ${t.online ? '' : '<span class="offline-tag">desconectada</span>'}
            ${removeBtn(t)}
          </div>`
        )
        .join('')
    : '<div class="hint">Aguardando equipes se juntarem…</div>';

  if (isWelcome) {
    stopTick();
    els.welcomeTeams.innerHTML = game.teams.length
      ? game.teams
          .map(
            (t) =>
              `<div class="team-line ${t.online ? '' : 'offline'}">${esc(t.name)}${t.online ? '' : ' <span class="offline-tag">desconectada</span>'}${removeBtn(t)}</div>`
          )
          .join('')
      : '<div class="hint">Aguardando equipes — escaneie o QR code para participar</div>';
    els.welcomeStartBtn.textContent = game.teams.length
      ? `Iniciar Jogo (${game.teams.length} equipe${game.teams.length > 1 ? 's' : ''})`
      : 'Iniciar Jogo';
    els.welcomeStartBtn.disabled = game.questionCount === 0;
    els.progress.textContent = game.questionSet ? game.questionSet.title : '';
    renderSetPicker(game);
    return;
  }

  const { question } = game;

  els.progress.textContent = `${game.questionSet ? game.questionSet.title + ' · ' : ''}Pergunta ${Math.min(game.questionIndex + 1, game.questionCount)} / ${game.questionCount}`;
  els.countdown.classList.add('hidden');

  if (!question || game.phase === 'finished') {
    stopTick();
    els.phase.textContent = PHASE_LABELS.finished;
    els.question.textContent = game.phase === 'finished' ? 'Fim de jogo!' : 'Pressione "Próxima Pergunta" para começar';
    els.qimg.classList.add('hidden');
    els.answers.innerHTML = '';
    els.reveal.classList.add('hidden');
    els.buzzQueue.innerHTML = '';
    renderStatus(game);
    els.confirmBtn.classList.add('hidden');
    els.resultsBtn.classList.toggle('hidden', game.phase !== 'finished');
    els.startBtn.classList.toggle('hidden', game.phase === 'finished');
    els.startBtn.textContent = 'Próxima Pergunta';
    renderRanking(game.teams);
    if (game.phase === 'finished' && !resultsShownFor) {
      resultsShownFor = true;
      els.resultsOverlay.classList.remove('hidden');
    }
    return;
  }
  resultsShownFor = false;

  const revealed = game.phase === 'revealed';
  els.phase.textContent = `${(question.category || 'Geral').toUpperCase()} · ${PHASE_LABELS[game.phase] || String(game.phase).toUpperCase()}`;
  els.question.textContent = question.question;
  if (question.image) {
    if (els.qimg.getAttribute('src') !== question.image) els.qimg.src = question.image;
    els.qimg.classList.remove('hidden');
  } else {
    els.qimg.removeAttribute('src');
    els.qimg.classList.add('hidden');
  }

  els.answers.innerHTML = question.answers
    .map((a, i) => {
      if (!a) return '';
      let cls = 'answer-item';
      let count = '';
      if (revealed) {
        cls += i === question.correct ? ' correct' : ' faded';
        const n = game.responses.filter((r) => r.answer === i).length;
        if (n) count = `<span class="answer-count">${n} equipe${n === 1 ? '' : 's'}</span>`;
      }
      return `<li class="${cls}"><span class="letter">${LETTERS[i]}</span><span class="answer-text">${esc(a)}</span>${count}</li>`;
    })
    .join('');

  if (revealed) {
    els.reveal.classList.remove('hidden');
    els.reveal.className = 'reveal ok-box';
    els.reveal.innerHTML = `Resposta correta: <strong>${LETTERS[question.correct]}</strong> — ${esc(question.answers[question.correct])}`;
  } else {
    els.reveal.classList.add('hidden');
  }

  renderStatus(game);
  if (renderResponses(game)) startTick();
  else stopTick();

  els.confirmBtn.classList.toggle('hidden', game.phase !== 'buzzing');
  els.resultsBtn.classList.add('hidden');

  const hasMore = game.questionIndex + 1 < game.questionCount;
  els.startBtn.classList.toggle('hidden', game.phase === 'buzzing');
  els.startBtn.textContent = hasMore ? 'Próxima Pergunta' : 'Finalizar';

  renderRanking(game.teams);
}

socket.on('game', render);

// ---------- Escolha do arquivo de perguntas ----------

let questionSets = [];

function refreshSets() {
  socket.emit('host:listSets', (sets) => {
    questionSets = Array.isArray(sets) ? sets : [];
    if (lastGame) renderSetPicker(lastGame);
  });
}

function renderSetPicker(game) {
  const current = game.questionSet ? game.questionSet.file : '';
  const options = questionSets
    .map((s) => `<option value="${esc(s.file)}"${s.count ? '' : ' disabled'}>${esc(s.title)} (${s.count} pergunta${s.count === 1 ? '' : 's'})</option>`)
    .join('');
  if (els.setSelect.dataset.html !== options) {
    els.setSelect.innerHTML = options || '<option value="">Nenhum arquivo em perguntas/</option>';
    els.setSelect.dataset.html = options;
  }
  if (document.activeElement !== els.setSelect) els.setSelect.value = current;
  const info = questionSets.find((s) => s.file === current);
  els.setInfo.textContent = info && info.problems
    ? `⚠️ ${info.problems} linha(s) com problema foram ignoradas — veja o terminal do servidor.`
    : '';
}

els.setSelect.onchange = () => {
  const file = els.setSelect.value;
  els.setSelect.disabled = true;
  socket.emit('host:selectSet', file, (res) => {
    els.setSelect.disabled = false;
    if (!res || !res.ok) {
      alert((res && res.error) || 'Não foi possível trocar as perguntas.');
      if (lastGame) els.setSelect.value = lastGame.questionSet ? lastGame.questionSet.file : '';
    }
  });
};

socket.on('connect', refreshSets);

// ---------- Cópia de segurança da partida ----------
// O servidor envia uma cópia da partida a cada mudança e ela fica guardada neste
// navegador. Se o servidor reiniciar (no Render gratuito isso apaga tudo), a cópia
// é devolvida ao reconectar e a partida continua de onde parou.
const BACKUP_KEY = 'revisao-host-backup';

function loadBackup() {
  try {
    return JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null');
  } catch {
    return null;
  }
}

socket.on('host:backup', (backup) => {
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
  } catch {}
});

socket.on('connect', () => {
  socket.emit('host:hello', loadBackup(), (res) => {
    if (res && res.restored) {
      const at = new Date(res.savedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      showToast(`O servidor reiniciou — partida restaurada (cópia das ${at}).`);
    }
  });
});

let toastTimer = null;
function showToast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 8000);
}

// Atalho do apresentador: Espaço/Enter aciona o botão principal visível.
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' && e.key !== 'Enter') return;
  if (e.target.closest('input, textarea, button, select') || !els.resultsOverlay.classList.contains('hidden')) return;
  const btn = [els.welcomeStartBtn, els.confirmBtn, els.startBtn].find(
    (b) => b.offsetParent !== null && !b.disabled
  );
  if (btn) {
    e.preventDefault();
    btn.click();
  }
});
