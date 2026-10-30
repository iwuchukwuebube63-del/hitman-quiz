(() => {
  'use strict';

  const $app = document.getElementById('app');
  const LET = 'ABCDEF';
  const state = { user: null, config: { siteName: 'HITMAN Quiz', watermark: '', template: null } };

  let renderToken = 0;
  let cleanups = [];
  let actions = {};
  let forms = {};
  let inputHandler = null;

  // ---------- helpers ----------
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtClock = (ms) => {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  };
  const fmtDur = (ms) => {
    const s = Math.round(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3400);
  }

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      /* empty body */
    }
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Copied.');
  }

  function safeNext(n) {
    return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/';
  }

  // ---------- shell ----------
  function shell(inner, opts = {}) {
    const u = state.user;
    const nav = [
      '<a href="/" data-link>Quizzes</a>',
      '<a href="/create" data-link>Create</a>',
      u ? '<a href="/me" data-link>My results</a>' : '',
      u && u.role === 'admin' ? '<a href="/admin" data-link>Admin</a>' : '',
      u
        ? '<button class="linkbtn" data-act="logout">Log out</button>'
        : '<a class="btn btn-small btn-primary" href="/login" data-link>Log in</a>',
    ].join('');
    return `<header class="topbar"><a class="brand" href="/" data-link><span class="brand-bubble" aria-hidden="true"></span>${esc(
      state.config.siteName
    )}</a><nav class="nav">${nav}</nav></header><main class="wrap${opts.wide ? ' wide' : ''}">${inner}</main>`;
  }

  function quizRow(q) {
    return `<a class="qrow" href="/q/${esc(q.code)}" data-link>
      <span class="qcode">${esc(q.courseCode || 'Quiz')}</span>
      <span class="qmain">
        <strong class="qtitle">${esc(q.title)}</strong>
        ${q.subtitle ? `<span class="qsub">${esc(q.subtitle)}</span>` : ''}
        <span class="qmeta">
          ${q.subject ? `<span>${esc(q.subject)}</span>` : ''}
          <span>${plural(q.questionCount, 'question')}</span>
          <span>${q.durationMinutes} min</span>
          <span>${plural(q.attempts, 'attempt')}</span>
          ${q.official ? '<span class="chip chip-mark">Official</span>' : `<span>by ${esc(q.ownerName)}</span>`}
        </span>
      </span>
    </a>`;
  }

  // ---------- router ----------
  const routes = [
    [/^\/$/, homePage],
    [/^\/login$/, authPage],
    [/^\/create$/, createPage],
    [/^\/q\/([a-f0-9]{8})$/, quizPage],
    [/^\/attempt\/([a-f0-9]{24})$/, attemptPage],
    [/^\/result\/([a-f0-9]{24})$/, resultPage],
    [/^\/me$/, mePage],
    [/^\/admin$/, adminPage],
  ];

  function navigate(url, replace) {
    history[replace ? 'replaceState' : 'pushState'](null, '', url);
    window.scrollTo(0, 0);
    render();
  }

  async function render() {
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        /* ignore */
      }
    });
    cleanups = [];
    actions = {};
    forms = {};
    inputHandler = null;
    const token = ++renderToken;
    const ctx = {
      alive: () => token === renderToken,
      paint: (html) => {
        if (token === renderToken) $app.innerHTML = html;
      },
      onLeave: (fn) => cleanups.push(fn),
    };
    const path = location.pathname.replace(/\/+$/, '') || '/';
    for (const [rx, fn] of routes) {
      const m = path.match(rx);
      if (!m) continue;
      try {
        await fn(ctx, ...m.slice(1));
      } catch (e) {
        if (!ctx.alive()) return;
        if (e.status === 401) {
          state.user = null;
          return navigate('/login?next=' + encodeURIComponent(location.pathname), true);
        }
        ctx.paint(
          shell(
            `<div class="empty"><h1>We hit a problem</h1><p>${esc(e.message)}</p><a class="btn" href="/" data-link>Back to quizzes</a></div>`
          )
        );
      }
      return;
    }
    ctx.paint(
      shell(`<div class="empty"><h1>Page not found</h1><p>That link does not lead anywhere.</p><a class="btn" href="/" data-link>Back to quizzes</a></div>`)
    );
  }

  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-link]');
    if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      navigate(link.getAttribute('href'));
      return;
    }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const name = el.dataset.act;
    const fn = actions[name] || globalActions[name];
    if (fn) fn(el, e);
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    const fn = forms[f.dataset.form];
    if (fn) fn(f);
  });
  document.addEventListener('input', (e) => inputHandler && inputHandler(e));
  document.addEventListener('change', (e) => inputHandler && inputHandler(e));
  window.addEventListener('popstate', render);

  const globalActions = {
    logout: async () => {
      try {
        await api('/logout', { method: 'POST' });
      } catch (e) {
        /* ignore */
      }
      state.user = null;
      navigate('/');
    },
    copy: (el) => copyText(el.dataset.text),
  };

  // ---------- home ----------
  async function homePage(ctx) {
    ctx.paint(shell('<p class="loading">Loading quizzes…</p>'));
    const [off, com] = await Promise.all([api('/quizzes?scope=official'), api('/quizzes?scope=community')]);
    if (!ctx.alive()) return;

    const list = (arr, emptyMsg) =>
      arr.length ? arr.map(quizRow).join('') : `<p class="empty">${emptyMsg}</p>`;

    ctx.paint(
      shell(`
      <section class="intro">
        <h1>Pick a quiz and beat the clock.</h1>
        <p>Answers save as you go, and your quiz submits itself when time runs out.</p>
      </section>
      ${
        state.user
          ? ''
          : `<div class="joinbar"><p>Join with a username and password to take quizzes and keep your scores.</p><a class="btn btn-primary btn-small" href="/login" data-link>Join or log in</a></div>`
      }
      <input class="search" id="search" type="search" placeholder="Search by title, subject or course code" aria-label="Search quizzes">
      <div id="results" hidden></div>
      <div id="sections">
        <div class="section-head"><h2>Today's quizzes</h2></div>
        ${list(off.quizzes, 'No official quizzes yet. Check back soon.')}
        <div class="section-head"><h2>Community quizzes</h2><a class="btn btn-small" href="/create" data-link>Create a quiz</a></div>
        ${list(com.quizzes, 'Nobody has shared a quiz yet. Be the first.')}
      </div>`)
    );

    let timer;
    inputHandler = (e) => {
      if (e.target.id !== 'search') return;
      clearTimeout(timer);
      const q = e.target.value.trim();
      timer = setTimeout(async () => {
        const results = document.getElementById('results');
        const sections = document.getElementById('sections');
        if (!results || !sections) return;
        if (!q) {
          results.hidden = true;
          sections.hidden = false;
          return;
        }
        try {
          const r = await api('/quizzes?scope=all&q=' + encodeURIComponent(q));
          if (!ctx.alive()) return;
          results.innerHTML = `<div class="section-head"><h2>Results</h2></div>${list(r.quizzes, 'No quizzes match that search.')}`;
          results.hidden = false;
          sections.hidden = true;
        } catch (err) {
          toast(err.message);
        }
      }, 300);
    };
    ctx.onLeave(() => clearTimeout(timer));
  }

  // ---------- login / join ----------
  async function authPage(ctx) {
    if (state.user) return navigate('/', true);
    const next = safeNext(new URLSearchParams(location.search).get('next'));
    let mode = 'login';

    const view = () =>
      ctx.paint(
        shell(`
        <div class="authbox">
          <h1>${mode === 'login' ? 'Welcome back' : 'Join in seconds'}</h1>
          <p class="muted">${mode === 'login' ? 'Log in to take quizzes and see your scores.' : 'Pick a username and password. No email needed.'}</p>
          <div class="seg" role="tablist">
            <button type="button" class="${mode === 'login' ? 'on' : ''}" data-act="mode" data-mode="login">Log in</button>
            <button type="button" class="${mode === 'join' ? 'on' : ''}" data-act="mode" data-mode="join">Join</button>
          </div>
          <form data-form="auth">
            <label>Username
              <input type="text" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required minlength="3" maxlength="20">
            </label>
            <label>Password
              <input type="password" name="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required minlength="6" maxlength="72">
            </label>
            <p class="err" id="err" role="alert"></p>
            <button class="btn btn-primary" type="submit" style="width:100%">${mode === 'login' ? 'Log in' : 'Join and continue'}</button>
          </form>
        </div>`)
      );
    view();

    actions.mode = (el) => {
      mode = el.dataset.mode;
      view();
    };
    forms.auth = async (f) => {
      const btn = f.querySelector('button[type=submit]');
      const err = f.querySelector('#err');
      err.textContent = '';
      btn.disabled = true;
      try {
        const data = await api(mode === 'login' ? '/login' : '/register', {
          method: 'POST',
          body: { username: f.username.value.trim(), password: f.password.value },
        });
        state.user = data.user;
        navigate(next, true);
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
      }
    };
  }

  // ---------- quiz details ----------
  async function quizPage(ctx, code) {
    ctx.paint(shell('<p class="loading">Loading quiz…</p>'));
    const [{ quiz }, lb] = await Promise.all([api('/quizzes/' + code), api('/quizzes/' + code + '/leaderboard')]);
    if (!ctx.alive()) return;
    const link = location.origin + '/q/' + quiz.code;
    const myHandle = state.user ? state.user.username : null;

    ctx.paint(
      shell(`
      <div class="qhead">
        <span class="qcode">${esc(quiz.courseCode || 'Quiz')}</span>
        <h1>${esc(quiz.title)}</h1>
        ${quiz.subtitle ? `<p class="muted">${esc(quiz.subtitle)}</p>` : ''}
      </div>
      <dl class="facts">
        ${quiz.subject ? `<div><dt>Subject</dt><dd>${esc(quiz.subject)}</dd></div>` : ''}
        <div><dt>Questions</dt><dd>${quiz.questionCount}</dd></div>
        <div><dt>Time limit</dt><dd>${quiz.durationMinutes} min</dd></div>
        <div><dt>Attempts</dt><dd>${quiz.attempts}</dd></div>
        <div><dt>Made by</dt><dd>${esc(quiz.official ? 'Admin' : quiz.ownerName)}</dd></div>
      </dl>
      <ul class="rules">
        <li>The timer starts when you press Start and cannot be paused.</li>
        <li>Your answers save as you go. If you close the page, you can come back and continue until time is up.</li>
        <li>When time ends, your answers are submitted automatically. You can also submit early.</li>
      </ul>
      <div class="btn-row">
        ${
          state.user
            ? '<button class="btn btn-primary" data-act="start">Start quiz</button>'
            : `<a class="btn btn-primary" href="/login?next=${encodeURIComponent('/q/' + quiz.code)}" data-link>Log in to start</a>`
        }
        ${quiz.canDelete ? '<button class="btn btn-danger" data-act="del">Delete quiz</button>' : ''}
      </div>
      <h3>Share this quiz</h3>
      <div class="share"><input type="text" readonly value="${esc(link)}" aria-label="Quiz link"><button class="btn btn-small" data-act="copy" data-text="${esc(link)}">Copy link</button></div>
      <div class="section-head"><h2>Leaderboard</h2></div>
      ${
        lb.leaderboard.length
          ? `<ol class="board">${lb.leaderboard
              .map(
                (r, i) =>
                  `<li class="${myHandle && r.username.toLowerCase() === myHandle.toLowerCase() ? 'me' : ''}"><span class="rk">${i + 1}</span><span>${esc(r.username)}</span><span class="sc">${r.score}/${r.total}</span><span class="tm muted">${fmtDur(r.timeMs)}</span></li>`
              )
              .join('')}</ol>`
          : '<p class="empty">Nobody has finished this quiz yet.</p>'
      }`)
    );

    actions.start = async (el) => {
      el.disabled = true;
      try {
        const data = await api('/quizzes/' + quiz.code + '/start', { method: 'POST' });
        navigate('/attempt/' + data.attempt.id);
      } catch (e) {
        toast(e.message);
        el.disabled = false;
      }
    };
    actions.del = async () => {
      if (!confirm('Delete this quiz and all its results? This cannot be undone.')) return;
      try {
        await api('/quizzes/' + quiz.code, { method: 'DELETE' });
        toast('Quiz deleted.');
        navigate('/');
      } catch (e) {
        toast(e.message);
      }
    };
  }

  // ---------- taking a quiz ----------
  async function attemptPage(ctx, id) {
    const data = await api('/attempts/' + id);
    if (!ctx.alive()) return;
    if (data.status === 'submitted') return navigate('/result/' + id, true);

    const a = data.attempt;
    const offset = a.serverNow - Date.now();
    const answers = a.answers.slice();
    const total = a.questions.length;
    let submitting = false;
    let saveTimer = null;
    let tick = null;

    const questionsHtml = a.questions
      .map(
        (q, i) => `<section class="qblock" data-q="${i}">
        <h2 class="qtext"><span class="qnum">${i + 1}</span><span>${esc(q.text)}</span></h2>
        <div class="opts" role="radiogroup" aria-label="Question ${i + 1}">
          ${q.options
            .map(
              (o, j) =>
                `<button type="button" class="opt${answers[i] === j ? ' sel' : ''}" data-act="pick" data-q="${i}" data-o="${j}" role="radio" aria-checked="${answers[i] === j}"><span class="bubble">${LET[j]}</span><span class="otext">${esc(o)}</span></button>`
            )
            .join('')}
        </div>
      </section>`
      )
      .join('');

    ctx.paint(`
      <div class="exambar">
        <span class="ttl">${esc(a.title)}</span>
        <span class="timer" id="timer" aria-live="off">${fmtClock(a.endsAt - (Date.now() + offset))}</span>
        <button class="btn btn-primary btn-small" data-act="submit" id="submitTop">Submit</button>
      </div>
      <div class="progress"><span id="bar"></span></div>
      <main class="wrap">
        <p class="muted" id="count"></p>
        ${questionsHtml}
        <div class="submitbar"><button class="btn btn-primary" data-act="submit" id="submitBottom">Submit answers</button></div>
      </main>`);

    const answeredCount = () => answers.filter((x) => x >= 0).length;
    const updateProgress = () => {
      const n = answeredCount();
      const bar = document.getElementById('bar');
      const count = document.getElementById('count');
      if (bar) bar.style.width = (total ? (n / total) * 100 : 0) + '%';
      if (count) count.textContent = `${n} of ${total} answered`;
    };
    updateProgress();

    const queueSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        api('/attempts/' + id + '/answers', { method: 'PUT', body: { answers } }).catch(() => {});
      }, 500);
    };

    const setBusy = (busy) => {
      ['submitTop', 'submitBottom'].forEach((bid) => {
        const b = document.getElementById(bid);
        if (b) b.disabled = busy;
      });
    };

    async function submit(auto) {
      if (submitting) return;
      submitting = true;
      clearInterval(tick);
      clearTimeout(saveTimer);
      setBusy(true);
      if (auto) toast("Time is up. Submitting your answers…");
      for (let tries = 0; tries < 6; tries++) {
        try {
          await api('/attempts/' + id + '/submit', { method: 'POST', body: { answers, auto: !!auto } });
          if (ctx.alive()) navigate('/result/' + id, true);
          return;
        } catch (e) {
          if (!ctx.alive()) return;
          if (e.status === 401) return navigate('/login?next=' + encodeURIComponent('/attempt/' + id), true);
          if (e.status === 404) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      submitting = false;
      setBusy(false);
      if (ctx.alive()) {
        toast('Could not submit yet. Check your connection and tap Submit again.');
        startTick();
      }
    }

    function startTick() {
      clearInterval(tick);
      let lastShown = '';
      tick = setInterval(() => {
        const rem = a.endsAt - (Date.now() + offset);
        const el = document.getElementById('timer');
        if (el) {
          const txt = fmtClock(rem);
          if (txt !== lastShown) {
            el.textContent = txt;
            lastShown = txt;
          }
          el.classList.toggle('low', rem <= 60000);
        }
        if (rem <= 0) submit(true);
      }, 250);
    }
    startTick();
    ctx.onLeave(() => {
      clearInterval(tick);
      clearTimeout(saveTimer);
    });

    actions.pick = (el) => {
      if (submitting) return;
      const i = Number(el.dataset.q);
      const j = Number(el.dataset.o);
      answers[i] = answers[i] === j ? -1 : j; // tap again to erase, like rubbing out a bubble
      el.closest('.qblock')
        .querySelectorAll('.opt')
        .forEach((b, idx) => {
          const on = answers[i] === idx;
          b.classList.toggle('sel', on);
          b.setAttribute('aria-checked', String(on));
        });
      updateProgress();
      queueSave();
    };
    actions.submit = () => {
      if (submitting) return;
      const left = total - answeredCount();
      const msg =
        left > 0
          ? `You have ${plural(left, 'unanswered question')}. Submit anyway?`
          : 'Submit your answers now?';
      if (confirm(msg)) submit(false);
    };
  }

  // ---------- result + flashcard ----------
  function verdictFor(p) {
    if (p >= 90) return 'Outstanding';
    if (p >= 75) return 'Great work';
    if (p >= 60) return 'Good effort';
    if (p >= 50) return 'You passed';
    if (p >= 40) return 'Keep pushing';
    return 'Try again, you will get it';
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function wrapLines(g, text, maxW, maxLines) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (g.measureText(test).width <= maxW || !line) line = test;
      else {
        lines.push(line);
        line = w;
      }
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      lines.length = maxLines;
      let last = lines[maxLines - 1];
      while (last.length > 1 && g.measureText(last + '…').width > maxW) last = last.slice(0, -1);
      lines[maxLines - 1] = last + '…';
    }
    return lines;
  }

  async function slipBlob(r) {
    try {
      await Promise.all([
        document.fonts.load('800 100px "Bricolage Grotesque"'),
        document.fonts.load('700 40px "Bricolage Grotesque"'),
        document.fonts.load('500 32px "DM Sans"'),
      ]);
    } catch (e) {
      /* fall back to system fonts */
    }
    const W = 1080;
    const H = 1350;
    const M = 90;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const DISPLAY = '"Bricolage Grotesque", "DM Sans", sans-serif';
    const BODY = '"DM Sans", sans-serif';
    const MUTED = '#9AA5C4';

    g.fillStyle = '#10152B';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#2B3AF0';
    g.fillRect(0, 0, W, 18);

    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = '#FFFFFF';
    g.font = `700 42px ${DISPLAY}`;
    g.fillText(state.config.siteName, M, 130);
    g.textAlign = 'right';
    g.fillStyle = MUTED;
    g.font = `400 32px ${BODY}`;
    g.fillText(fmtDate(r.submittedAt), W - M, 130);

    let y = 215;
    if (r.courseCode) {
      g.font = `700 32px ${BODY}`;
      const tw = g.measureText(r.courseCode).width;
      g.fillStyle = '#FFD84D';
      roundRect(g, M, y - 38, tw + 40, 56, 10);
      g.fill();
      g.fillStyle = '#1A1500';
      g.textAlign = 'left';
      g.fillText(r.courseCode, M + 20, y + 2);
      y += 90;
    } else {
      y += 20;
    }

    g.textAlign = 'left';
    g.fillStyle = '#FFFFFF';
    g.font = `800 70px ${DISPLAY}`;
    const titleLines = wrapLines(g, r.title, W - M * 2, 3);
    titleLines.forEach((ln, i) => g.fillText(ln, M, y + i * 82));
    y += titleLines.length * 82 - 20;

    const subline = r.subtitle || r.subject;
    if (subline) {
      g.fillStyle = MUTED;
      g.font = `500 36px ${BODY}`;
      const sl = wrapLines(g, subline, W - M * 2, 1);
      g.fillText(sl[0], M, y + 20);
    }

    // score
    const scoreY = 800;
    g.font = `800 340px ${DISPLAY}`;
    const nW = g.measureText(String(r.score)).width;
    g.font = `700 120px ${DISPLAY}`;
    const ofText = '/' + r.total;
    const oW = g.measureText(ofText).width;
    const startX = (W - (nW + 16 + oW)) / 2;
    g.textAlign = 'left';
    g.fillStyle = '#FFD84D';
    g.font = `800 340px ${DISPLAY}`;
    g.fillText(String(r.score), startX, scoreY);
    g.fillStyle = '#FFFFFF';
    g.font = `700 120px ${DISPLAY}`;
    g.fillText(ofText, startX + nW + 16, scoreY);

    g.textAlign = 'center';
    g.fillStyle = '#FFFFFF';
    g.font = `800 96px ${DISPLAY}`;
    g.fillText(r.percent + '%', W / 2, 935);
    g.fillStyle = MUTED;
    g.font = `500 44px ${BODY}`;
    g.fillText(verdictFor(r.percent), W / 2, 995);

    g.strokeStyle = '#3A4468';
    g.lineWidth = 3;
    g.setLineDash([16, 14]);
    g.beginPath();
    g.moveTo(M, 1060);
    g.lineTo(W - M, 1060);
    g.stroke();
    g.setLineDash([]);

    const cols = [
      [r.score, 'Correct'],
      [r.wrong, 'Wrong'],
      [r.skipped, 'Skipped'],
    ];
    const colW = (W - M * 2) / 3;
    cols.forEach(([n, label], i) => {
      const cx = M + colW * i + colW / 2;
      g.fillStyle = '#FFFFFF';
      g.font = `800 70px ${DISPLAY}`;
      g.fillText(String(n), cx, 1150);
      g.fillStyle = MUTED;
      g.font = `500 30px ${BODY}`;
      g.fillText(label, cx, 1196);
    });

    g.textAlign = 'left';
    g.fillStyle = '#FFFFFF';
    g.font = `700 38px ${BODY}`;
    const nameLines = wrapLines(g, r.username, 420, 1);
    g.fillText(nameLines[0], M, 1290);
    g.textAlign = 'right';
    g.fillStyle = MUTED;
    g.font = `500 34px ${BODY}`;
    g.fillText(state.config.watermark || '', W - M, 1290);

    return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  }

  async function resultPage(ctx, id) {
    ctx.paint(shell('<p class="loading">Loading your result…</p>'));
    const data = await api('/attempts/' + id);
    if (!ctx.alive()) return;
    if (data.status === 'active') return navigate('/attempt/' + id, true);
    const r = data.result;

    const reviewHtml = (onlyMissed) => {
      const items = r.review.filter((x) => (onlyMissed ? !x.isCorrect : true));
      if (!items.length) {
        return '<p class="empty">You got every question right. Nothing to review.</p>';
      }
      return items
        .map(
          (x) => `<article class="rev">
          <h3><span class="qnum">${x.index}</span><span>${esc(x.text)}</span></h3>
          <div class="opts">
            ${x.options
              .map((o, j) => {
                const isCorrect = j === x.correct;
                const isYours = j === x.yours;
                const cls = isCorrect ? ' correct' : isYours ? ' wrong' : '';
                const tag = isCorrect ? (isYours ? 'Your answer, correct' : 'Correct answer') : isYours ? 'Your answer' : '';
                return `<div class="opt ro${cls}"><span class="bubble">${LET[j]}</span><span class="otext">${esc(o)}</span>${tag ? `<span class="tag">${tag}</span>` : ''}</div>`;
              })
              .join('')}
          </div>
          ${x.yours === -1 ? '<p class="skipped">You skipped this question.</p>' : ''}
          ${x.explanation ? `<p class="expl">${esc(x.explanation)}</p>` : ''}
        </article>`
        )
        .join('');
    };

    const missed = r.review.filter((x) => !x.isCorrect).length;
    ctx.paint(
      shell(`
      <div class="slip" id="slip">
        <div class="slip-top"><strong>${esc(state.config.siteName)}</strong><span>${fmtDate(r.submittedAt)}</span></div>
        ${r.courseCode ? `<span class="chip chip-mark">${esc(r.courseCode)}</span>` : ''}
        <h1 class="slip-title">${esc(r.title)}</h1>
        ${r.subtitle || r.subject ? `<p class="slip-sub">${esc(r.subtitle || r.subject)}</p>` : ''}
        <div class="slip-score"><span class="n">${r.score}</span><span class="of">/${r.total}</span></div>
        <div class="slip-pct">${r.percent}%</div>
        <p class="slip-verdict">${esc(verdictFor(r.percent))}</p>
        <hr class="slip-tear">
        <div class="slip-stats">
          <div><b>${r.score}</b><span>Correct</span></div>
          <div><b>${r.wrong}</b><span>Wrong</span></div>
          <div><b>${r.skipped}</b><span>Skipped</span></div>
        </div>
        <div class="slip-foot"><strong>${esc(r.username)}</strong><span>${esc(state.config.watermark)}</span></div>
      </div>
      <p class="slip-note">${r.auto ? 'Time ran out, so your answers were submitted automatically. ' : ''}Finished in ${fmtDur(r.timeUsedMs)}.</p>
      <div class="btn-row" style="justify-content:center">
        <button class="btn btn-primary" data-act="saveimg">Save as image</button>
        <a class="btn" href="/q/${esc(r.quizCode)}" data-link>Retake or see leaderboard</a>
      </div>
      <div class="tabs" role="tablist">
        <button type="button" class="on" data-act="tab" data-t="missed">Missed (${missed})</button>
        <button type="button" data-act="tab" data-t="all">All questions (${r.review.length})</button>
      </div>
      <div id="review">${reviewHtml(true)}</div>`)
    );

    actions.tab = (el) => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b === el));
      document.getElementById('review').innerHTML = reviewHtml(el.dataset.t === 'missed');
    };
    actions.saveimg = async (el) => {
      el.disabled = true;
      try {
        const blob = await slipBlob(r);
        if (!blob) throw new Error('Could not create the image.');
        const file = new File([blob], 'quiz-score.png', { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: r.title });
            return;
          } catch (err) {
            if (err && err.name === 'AbortError') return;
          }
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'quiz-score.png';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (e) {
        toast(e.message || 'Could not save the image. Take a screenshot instead.');
      } finally {
        el.disabled = false;
      }
    };
  }

  // ---------- my results + my quizzes ----------
  async function mePage(ctx) {
    ctx.paint(shell('<p class="loading">Loading…</p>'));
    const [att, mine] = await Promise.all([api('/my/attempts'), api('/quizzes?scope=mine')]);
    if (!ctx.alive()) return;

    ctx.paint(
      shell(`
      <h1>My results</h1>
      ${
        att.attempts.length
          ? att.attempts
              .map(
                (x) => `<div class="row">
              <div class="main"><strong>${esc(x.title)}</strong><br><span class="muted">${esc(x.courseCode || '')} ${fmtDate(x.submittedAt)}</span></div>
              <div class="side"><span class="scorepill">${x.score}/${x.total}</span><span class="chip">${x.percent}%</span><a class="btn btn-small" href="/result/${esc(x.id)}" data-link>Review</a></div>
            </div>`
              )
              .join('')
          : '<p class="empty">You have not finished any quizzes yet.</p>'
      }
      <div class="section-head"><h2>My quizzes</h2><a class="btn btn-small" href="/create" data-link>Create a quiz</a></div>
      ${
        mine.quizzes.length
          ? mine.quizzes
              .map(
                (q) => `<div class="row">
              <div class="main"><a href="/q/${esc(q.code)}" data-link><strong>${esc(q.title)}</strong></a><br><span class="muted">${plural(q.questionCount, 'question')}, ${q.durationMinutes} min, ${plural(q.attempts, 'attempt')}</span></div>
              <div class="side">
                <button class="btn btn-small" data-act="copy" data-text="${esc(location.origin + '/q/' + q.code)}">Copy link</button>
                <button class="btn btn-small btn-danger" data-act="del" data-code="${esc(q.code)}">Delete</button>
              </div>
            </div>`
              )
              .join('')
          : '<p class="empty">Quizzes you create will show up here with their share links.</p>'
      }`)
    );

    actions.del = async (el) => {
      if (!confirm('Delete this quiz and all its results? This cannot be undone.')) return;
      try {
        await api('/quizzes/' + el.dataset.code, { method: 'DELETE' });
        toast('Quiz deleted.');
        render();
      } catch (e) {
        toast(e.message);
      }
    };
  }

  // ---------- create a quiz ----------
  async function createPage(ctx) {
    if (!state.user) return navigate('/login?next=/create', true);

    const KEY = 'quizDraft.v1';
    const blankQ = () => ({ text: '', options: ['', '', '', ''], correct: 0, explanation: '' });
    const blankDraft = () => ({ title: '', subtitle: '', subject: '', courseCode: '', durationMinutes: 15, questions: [blankQ()] });

    function loadDraft() {
      try {
        const d = JSON.parse(localStorage.getItem(KEY));
        if (d && Array.isArray(d.questions) && d.questions.length) {
          d.questions = d.questions.map((q) => ({
            text: String(q.text || ''),
            options: Array.isArray(q.options) && q.options.length >= 2 ? q.options.slice(0, 6).map(String) : ['', '', '', ''],
            correct: Number.isInteger(q.correct) ? q.correct : 0,
            explanation: String(q.explanation || ''),
          }));
          return Object.assign(blankDraft(), d);
        }
      } catch (e) {
        /* ignore */
      }
      return blankDraft();
    }
    function saveDraft() {
      try {
        localStorage.setItem(KEY, JSON.stringify(draft));
      } catch (e) {
        /* storage full or blocked */
      }
    }

    let draft = loadDraft();
    let mode = 'build';
    let jsonText = '';

    const qEditor = (q, i) => `<fieldset class="qedit">
      <legend>Question ${i + 1}</legend>
      <textarea data-f="q.text" data-i="${i}" rows="2" maxlength="1000" placeholder="Type the question" aria-label="Question ${i + 1} text">${esc(q.text)}</textarea>
      <p class="hint">Tap the bubble beside the correct answer.</p>
      ${q.options
        .map(
          (o, j) => `<div class="oedit">
          <label class="pick" title="Mark ${LET[j]} as the correct answer"><input type="radio" name="c${i}" data-f="q.correct" data-i="${i}" data-j="${j}" ${q.correct === j ? 'checked' : ''}><span class="bubble">${LET[j]}</span></label>
          <input type="text" data-f="q.opt" data-i="${i}" data-j="${j}" value="${esc(o)}" maxlength="300" placeholder="Option ${LET[j]}" aria-label="Option ${LET[j]} of question ${i + 1}">
          ${q.options.length > 2 ? `<button type="button" class="iconbtn" data-act="rmopt" data-i="${i}" data-j="${j}">Remove</button>` : ''}
        </div>`
        )
        .join('')}
      <div class="qtools">
        ${q.options.length < 6 ? `<button type="button" class="btn btn-small" data-act="addopt" data-i="${i}">Add option</button>` : ''}
        ${draft.questions.length > 1 ? `<button type="button" class="btn btn-small btn-danger" data-act="rmq" data-i="${i}">Delete question</button>` : ''}
      </div>
      <input type="text" data-f="q.expl" data-i="${i}" value="${esc(q.explanation)}" maxlength="1000" placeholder="Explanation shown in the review (optional)" aria-label="Explanation for question ${i + 1}">
    </fieldset>`;

    const modeTabs = () => `<div class="seg" role="tablist">
      <button type="button" class="${mode === 'build' ? 'on' : ''}" data-act="cmode" data-m="build">Build here</button>
      <button type="button" class="${mode === 'json' ? 'on' : ''}" data-act="cmode" data-m="json">Paste JSON</button>
    </div>`;

    function viewBuild() {
      ctx.paint(
        shell(`
        <h1>Create a quiz</h1>
        <p class="muted">${state.user.role === 'admin' ? 'As an admin, your quizzes appear under Today\'s quizzes.' : 'You get a link to share as soon as it is published.'}</p>
        ${modeTabs()}
        <div class="fieldgrid">
          <label>Title<input type="text" data-f="title" value="${esc(draft.title)}" maxlength="120" placeholder="Cyber Security Basics"></label>
          <label>Subtitle<input type="text" data-f="subtitle" value="${esc(draft.subtitle)}" maxlength="160" placeholder="Week 3 test"></label>
          <label>Subject<input type="text" data-f="subject" value="${esc(draft.subject)}" maxlength="80" placeholder="Introduction to Cyber Security"></label>
          <label>Course code<input type="text" data-f="courseCode" value="${esc(draft.courseCode)}" maxlength="30" placeholder="CYB 101"></label>
          <label>Time limit (minutes)<input type="number" inputmode="numeric" min="1" max="300" data-f="durationMinutes" value="${esc(draft.durationMinutes)}"></label>
        </div>
        ${draft.questions.map(qEditor).join('')}
        <div class="btn-row">
          <button type="button" class="btn" data-act="addq">Add question</button>
          <button type="button" class="btn btn-primary" data-act="publish" id="pubBtn">Publish quiz</button>
        </div>
        <p class="err" id="err" role="alert"></p>
        <p class="hint">Your draft is saved on this device while you type.</p>`)
      );
    }

    function viewJson() {
      ctx.paint(
        shell(`
        <h1>Create a quiz</h1>
        <p class="muted">Paste your quiz as JSON, or choose a .json file. Each answer is the letter of the correct option.</p>
        ${modeTabs()}
        <label>JSON file<input type="file" id="jsonfile" accept=".json,application/json"></label>
        <label>Quiz JSON<textarea id="jsontext" rows="14" spellcheck="false" placeholder='{"title": "...", "durationMinutes": 10, "questions": [...]}'>${esc(jsonText)}</textarea></label>
        <div class="btn-row">
          <button type="button" class="btn" data-act="usetemplate">Insert example</button>
          <button type="button" class="btn btn-primary" data-act="publishjson" id="pubBtn">Publish quiz</button>
        </div>
        <p class="err" id="err" role="alert"></p>`)
      );
    }

    const view = () => (mode === 'build' ? viewBuild() : viewJson());
    view();

    inputHandler = (e) => {
      const t = e.target;
      if (t.id === 'jsonfile' && t.files && t.files[0]) {
        const file = t.files[0];
        if (file.size > 1024 * 1024) return toast('That file is too big. Keep it under 1 MB.');
        file.text().then((txt) => {
          jsonText = txt;
          const ta = document.getElementById('jsontext');
          if (ta) ta.value = txt;
        });
        return;
      }
      if (t.id === 'jsontext') {
        jsonText = t.value;
        return;
      }
      const f = t.dataset && t.dataset.f;
      if (!f) return;
      const i = Number(t.dataset.i);
      const j = Number(t.dataset.j);
      if (['title', 'subtitle', 'subject', 'courseCode', 'durationMinutes'].includes(f)) draft[f] = t.value;
      else if (f === 'q.text') draft.questions[i].text = t.value;
      else if (f === 'q.opt') draft.questions[i].options[j] = t.value;
      else if (f === 'q.expl') draft.questions[i].explanation = t.value;
      else if (f === 'q.correct') draft.questions[i].correct = j;
      saveDraft();
    };

    function buildPayload() {
      const qs = draft.questions.map((q, i) => {
        const n = i + 1;
        if (!q.text.trim()) throw new Error(`Question ${n} has no text.`);
        const opts = [];
        let corr = -1;
        q.options.forEach((o, j) => {
          if (o.trim()) {
            if (j === q.correct) corr = opts.length;
            opts.push(o.trim());
          }
        });
        if (opts.length < 2) throw new Error(`Question ${n} needs at least two filled-in options.`);
        if (corr < 0) throw new Error(`Question ${n}: mark a filled-in option as the correct answer.`);
        return { question: q.text.trim(), options: opts, answer: LET[corr], explanation: q.explanation.trim() };
      });
      if (!draft.title.trim()) throw new Error('Add a title.');
      return {
        title: draft.title.trim(),
        subtitle: draft.subtitle.trim(),
        subject: draft.subject.trim(),
        courseCode: draft.courseCode.trim(),
        durationMinutes: Number(draft.durationMinutes),
        questions: qs,
      };
    }

    function showSuccess(quiz, fromBuild) {
      const link = location.origin + '/q/' + quiz.code;
      if (fromBuild) {
        draft = blankDraft();
        try {
          localStorage.removeItem(KEY);
        } catch (e) {
          /* ignore */
        }
      } else {
        jsonText = '';
      }
      ctx.paint(
        shell(`
        <div class="success">
          <h1>Quiz published</h1>
          <p class="muted">${esc(quiz.title)} is live. Share this link so people can take it.</p>
          <div class="share"><input type="text" readonly value="${esc(link)}" aria-label="Quiz link"><button class="btn btn-small" data-act="copy" data-text="${esc(link)}">Copy link</button></div>
          <div class="btn-row" style="justify-content:center">
            <a class="btn btn-primary" href="/q/${esc(quiz.code)}" data-link>Open quiz</a>
            <button class="btn" data-act="another">Create another</button>
          </div>
        </div>`)
      );
    }

    const publishWith = async (payloadFn, fromBuild) => {
      const err = document.getElementById('err');
      const btn = document.getElementById('pubBtn');
      err.textContent = '';
      let payload;
      try {
        payload = payloadFn();
      } catch (e) {
        err.textContent = e.message;
        return;
      }
      btn.disabled = true;
      try {
        const data = await api('/quizzes', { method: 'POST', body: payload });
        if (ctx.alive()) showSuccess(data.quiz, fromBuild);
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
      }
    };

    actions.cmode = (el) => {
      mode = el.dataset.m;
      view();
    };
    actions.addq = () => {
      draft.questions.push(blankQ());
      saveDraft();
      view();
      const all = document.querySelectorAll('.qedit');
      if (all.length) all[all.length - 1].scrollIntoView({ block: 'center' });
    };
    actions.rmq = (el) => {
      draft.questions.splice(Number(el.dataset.i), 1);
      saveDraft();
      view();
    };
    actions.addopt = (el) => {
      const q = draft.questions[Number(el.dataset.i)];
      if (q.options.length < 6) q.options.push('');
      saveDraft();
      view();
    };
    actions.rmopt = (el) => {
      const q = draft.questions[Number(el.dataset.i)];
      const j = Number(el.dataset.j);
      if (q.options.length <= 2) return;
      q.options.splice(j, 1);
      if (q.correct === j) q.correct = 0;
      else if (q.correct > j) q.correct -= 1;
      saveDraft();
      view();
    };
    actions.publish = () => publishWith(buildPayload, true);
    actions.usetemplate = () => {
      jsonText = JSON.stringify(state.config.template || {}, null, 2);
      viewJson();
    };
    actions.publishjson = () =>
      publishWith(() => {
        let obj;
        try {
          obj = JSON.parse(jsonText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
        } catch (e) {
          throw new Error('That is not valid JSON: ' + e.message);
        }
        return Array.isArray(obj) ? { questions: obj } : obj;
      }, false);
    actions.another = () => {
      mode = 'build';
      draft = blankDraft();
      view();
    };
  }

  // ---------- admin ----------
  async function adminPage(ctx) {
    if (!state.user) return navigate('/login?next=/admin', true);
    if (state.user.role !== 'admin') {
      ctx.paint(shell('<div class="empty"><h1>Admins only</h1><p>You do not have access to this page.</p><a class="btn" href="/" data-link>Back to quizzes</a></div>'));
      return;
    }
    let tab = 'stats';
    let userQuery = '';
    let userTimer;

    const frame = (inner) =>
      ctx.paint(
        shell(
          `<h1>Admin</h1>
          <div class="tabs" role="tablist">
            ${[
              ['stats', 'Stats'],
              ['quizzes', 'Quizzes'],
              ['users', 'Users'],
            ]
              .map(([k, label]) => `<button type="button" class="${tab === k ? 'on' : ''}" data-act="atab" data-t="${k}">${label}</button>`)
              .join('')}
            <a class="btn btn-small btn-primary" href="/create" data-link>Upload a quiz</a>
          </div>
          <div id="panel">${inner}</div>`,
          { wide: true }
        )
      );

    async function load() {
      frame('<p class="loading">Loading…</p>');
      if (tab === 'stats') {
        const { stats: s } = await api('/admin/stats');
        if (!ctx.alive()) return;
        frame(`
          <div class="stats">
            <div class="stat big"><span class="n">${s.attempts.today}</span><span class="l">Attempts today</span></div>
            <div class="stat"><span class="n">${s.users.total}</span><span class="l">Users</span></div>
            <div class="stat"><span class="n">${s.users.today}</span><span class="l">Joined today</span></div>
            <div class="stat"><span class="n">${s.users.week}</span><span class="l">Joined this week</span></div>
            <div class="stat"><span class="n">${s.users.activeToday}</span><span class="l">Active today</span></div>
            <div class="stat"><span class="n">${s.quizzes.total}</span><span class="l">Quizzes</span></div>
            <div class="stat"><span class="n">${s.quizzes.official}</span><span class="l">Official quizzes</span></div>
            <div class="stat"><span class="n">${s.quizzes.community}</span><span class="l">Community quizzes</span></div>
            <div class="stat"><span class="n">${s.quizzes.today}</span><span class="l">Quizzes added today</span></div>
            <div class="stat"><span class="n">${s.attempts.total}</span><span class="l">Total attempts</span></div>
            <div class="stat"><span class="n">${s.attempts.active}</span><span class="l">In progress now</span></div>
            <div class="stat"><span class="n">${s.attempts.avgPercent}%</span><span class="l">Average score</span></div>
            <div class="stat"><span class="n">${s.users.admins}</span><span class="l">Admins</span></div>
            <div class="stat"><span class="n">${s.users.banned}</span><span class="l">Suspended users</span></div>
          </div>
          <h2>Most played</h2>
          ${
            s.top.length
              ? s.top.map((t) => `<div class="row"><div class="main"><a href="/q/${esc(t.code)}" data-link><strong>${esc(t.title)}</strong></a></div><span class="chip">${plural(t.attempts, 'attempt')}</span></div>`).join('')
              : '<p class="empty">No quizzes yet.</p>'
          }
          <p class="hint">Add or remove website admins from the Telegram bot with /addadmin and /removeadmin.</p>`);
      } else if (tab === 'quizzes') {
        const { quizzes } = await api('/quizzes?scope=all');
        if (!ctx.alive()) return;
        frame(
          quizzes.length
            ? quizzes
                .map(
                  (q) => `<div class="row">
              <div class="main"><a href="/q/${esc(q.code)}" data-link><strong>${esc(q.title)}</strong></a> ${q.official ? '<span class="chip chip-mark">Official</span>' : ''}<br><span class="muted">${esc(q.courseCode || 'No code')}, ${plural(q.questionCount, 'question')}, ${q.durationMinutes} min, ${plural(q.attempts, 'attempt')}, by ${esc(q.ownerName)}, ${fmtDate(q.createdAt)}</span></div>
              <div class="side">
                <button class="btn btn-small" data-act="copy" data-text="${esc(location.origin + '/q/' + q.code)}">Copy link</button>
                <button class="btn btn-small btn-danger" data-act="delq" data-code="${esc(q.code)}">Delete</button>
              </div>
            </div>`
                )
                .join('')
            : '<p class="empty">No quizzes yet.</p>'
        );
      } else {
        await loadUsers(true);
      }
    }

    async function loadUsers(full) {
      const { users, total } = await api('/admin/users?q=' + encodeURIComponent(userQuery));
      if (!ctx.alive()) return;
      const list = users.length
        ? users
            .map(
              (u) => `<div class="row">
          <div class="main"><strong>${esc(u.username)}</strong> ${u.role === 'admin' ? '<span class="chip chip-mark">Admin</span>' : ''} ${u.banned ? '<span class="chip chip-bad">Suspended</span>' : ''}<br>
            <span class="muted">Joined ${fmtDate(u.joinedAt)}, last seen ${u.lastSeen ? fmtDate(u.lastSeen) : 'never'}, ${plural(u.attempts, 'attempt')}${u.attempts ? ` (avg ${u.avgPercent}%)` : ''}, ${plural(u.quizzes, 'quiz')} created</span></div>
          <div class="side">${
            u.role === 'admin'
              ? ''
              : `<button class="btn btn-small ${u.banned ? '' : 'btn-danger'}" data-act="ban" data-h="${esc(u.handle)}" data-b="${u.banned ? '0' : '1'}">${u.banned ? 'Restore' : 'Suspend'}</button>`
          }</div>
        </div>`
            )
            .join('')
        : '<p class="empty">No users found.</p>';
      const html = `<p class="muted">Showing ${users.length} of ${total} users</p><div id="ulist">${list}</div>`;
      if (full) {
        frame(`<input type="search" id="usearch" placeholder="Search by username" value="${esc(userQuery)}" aria-label="Search users">${html}`);
      } else {
        const panelList = document.getElementById('ulist');
        if (panelList) panelList.outerHTML = `<div id="ulist">${list}</div>`;
      }
    }

    inputHandler = (e) => {
      if (e.target.id !== 'usearch') return;
      clearTimeout(userTimer);
      userQuery = e.target.value.trim();
      userTimer = setTimeout(() => loadUsers(false).catch((err) => toast(err.message)), 300);
    };
    ctx.onLeave(() => clearTimeout(userTimer));

    actions.atab = (el) => {
      tab = el.dataset.t;
      load().catch((e) => toast(e.message));
    };
    actions.delq = async (el) => {
      if (!confirm('Delete this quiz and all its results? This cannot be undone.')) return;
      try {
        await api('/quizzes/' + el.dataset.code, { method: 'DELETE' });
        toast('Quiz deleted.');
        load();
      } catch (e) {
        toast(e.message);
      }
    };
    actions.ban = async (el) => {
      const ban = el.dataset.b === '1';
      if (ban && !confirm('Suspend this user? They will not be able to log in.')) return;
      try {
        await api('/admin/users/' + encodeURIComponent(el.dataset.h) + '/ban', { method: 'POST', body: { banned: ban } });
        toast(ban ? 'User suspended.' : 'User restored.');
        if (ctx.alive()) await loadUsers(true);
      } catch (e) {
        toast(e.message);
      }
    };

    await load();
  }

  // ---------- boot ----------
  async function boot() {
    try {
      const [cfg, me] = await Promise.all([api('/config'), api('/me')]);
      state.config = cfg;
      state.user = me.user;
      document.title = cfg.siteName;
    } catch (e) {
      /* the site still works with defaults */
    }
    render();
  }
  boot();
})();
