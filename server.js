require('dotenv').config();
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const { User, Quiz, Attempt } = require('./models');
const util = require('./quizUtil');
const startBot = require('./bot');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const SITE_NAME = process.env.SITE_NAME || 'HITMAN Quiz';
const WATERMARK = process.env.WATERMARK_TEXT || '@OFFICIAL_HITMAN_GAMING';
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const GRACE_MS = 15000; // late-submit allowance for slow networks

if (!MONGODB_URI || !JWT_SECRET) {
  console.error('Missing MONGODB_URI or JWT_SECRET. Set them in your environment variables.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'"],
        'upgrade-insecure-requests': null,
      },
    },
  })
);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a few minutes and try again.' },
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down for a moment.' },
});

function signToken(user) {
  return jwt.sign({ id: user._id.toString() }, JWT_SECRET, { expiresIn: '30d' });
}
function setCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 3600 * 1000,
  });
}
function publicUser(u) {
  return { username: u.displayName, handle: u.username, role: u.role };
}

async function getUser(req) {
  const token = req.cookies && req.cookies.token;
  if (!token) return null;
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(id);
    if (!user) return null;
    if (!user.lastSeen || Date.now() - user.lastSeen.getTime() > 5 * 60 * 1000) {
      User.updateOne({ _id: user._id }, { $set: { lastSeen: new Date() } }).catch(() => {});
    }
    return user;
  } catch (e) {
    return null;
  }
}

const softAuth = wrap(async (req, res, next) => {
  req.user = await getUser(req);
  next();
});
const auth = wrap(async (req, res, next) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in to continue.' });
  if (user.banned) return res.status(403).json({ error: 'This account is suspended.' });
  req.user = user;
  next();
});
const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).json({ error: 'Admins only.' });
};

function quizMeta(q, user) {
  const mine = !!(user && q.owner && q.owner.equals(user._id));
  return {
    code: q.code,
    title: q.title,
    subtitle: q.subtitle,
    subject: q.subject,
    courseCode: q.courseCode,
    durationMinutes: q.durationMinutes,
    questionCount: q.questionCount,
    ownerName: q.ownerName,
    official: q.official,
    attempts: q.attempts,
    createdAt: q.createdAt.getTime(),
    mine,
    canDelete: mine || !!(user && user.role === 'admin'),
  };
}

function activePayload(attempt, quiz) {
  return {
    id: String(attempt._id),
    quizCode: quiz.code,
    title: quiz.title,
    subtitle: quiz.subtitle,
    subject: quiz.subject,
    courseCode: quiz.courseCode,
    durationMinutes: quiz.durationMinutes,
    startedAt: attempt.startedAt.getTime(),
    endsAt: attempt.endsAt.getTime(),
    serverNow: Date.now(),
    answers: Array.from(attempt.answers),
    questions: quiz.questions.map((q) => ({ text: q.text, options: q.options })),
  };
}

function resultPayload(attempt, quiz) {
  const review = quiz.questions.map((q, i) => {
    const yours = attempt.answers[i] == null ? -1 : attempt.answers[i];
    return {
      index: i + 1,
      text: q.text,
      options: q.options,
      yours,
      correct: q.correct,
      explanation: q.explanation,
      isCorrect: yours === q.correct,
    };
  });
  const total = attempt.total;
  return {
    id: String(attempt._id),
    quizCode: quiz.code,
    title: quiz.title,
    subtitle: quiz.subtitle,
    subject: quiz.subject,
    courseCode: quiz.courseCode,
    username: attempt.username,
    score: attempt.score,
    total,
    percent: total ? Math.round((attempt.score / total) * 100) : 0,
    skipped: review.filter((r) => r.yours === -1).length,
    wrong: review.filter((r) => r.yours !== -1 && !r.isCorrect).length,
    auto: attempt.auto,
    submittedAt: attempt.submittedAt.getTime(),
    timeUsedMs: Math.max(0, attempt.submittedAt.getTime() - attempt.startedAt.getTime()),
    review,
  };
}

// Grades and locks an attempt. Safe to call twice: only the first call wins.
async function finalize(attempt, quiz, auto) {
  if (attempt.status === 'submitted') return attempt;
  const answers = Array.from(attempt.answers);
  const score = util.gradeAnswers(quiz, answers);
  const submittedAt = new Date(Math.min(Date.now(), attempt.endsAt.getTime()));
  const updated = await Attempt.findOneAndUpdate(
    { _id: attempt._id, status: 'active' },
    {
      $set: {
        status: 'submitted',
        submittedAt,
        score,
        total: quiz.questions.length,
        auto: !!auto,
        answers,
      },
    },
    { new: true }
  );
  return updated || Attempt.findById(attempt._id);
}

// ---------- health (keep-awake target) ----------
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// ---------- API ----------
app.use('/api', apiLimiter);

app.get('/api/config', (req, res) => {
  res.json({ siteName: SITE_NAME, watermark: WATERMARK, template: util.TEMPLATE });
});

app.get(
  '/api/me',
  softAuth,
  (req, res) => {
    const u = req.user;
    res.json({ user: u && !u.banned ? publicUser(u) : null });
  }
);

app.post(
  '/api/register',
  authLimiter,
  wrap(async (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3 to 20 letters, numbers or underscores.' });
    }
    if (password.length < 6 || password.length > 72) {
      return res.status(400).json({ error: 'Password must be 6 to 72 characters.' });
    }
    const exists = await User.findOne({ username: username.toLowerCase() });
    if (exists) return res.status(409).json({ error: 'That username is taken. Try another.' });
    const passwordHash = await bcrypt.hash(password, 10);
    let user;
    try {
      user = await User.create({
        username: username.toLowerCase(),
        displayName: username,
        passwordHash,
        lastSeen: new Date(),
      });
    } catch (e) {
      if (e.code === 11000) return res.status(409).json({ error: 'That username is taken. Try another.' });
      throw e;
    }
    setCookie(res, signToken(user));
    res.json({ user: publicUser(user) });
  })
);

app.post(
  '/api/login',
  authLimiter,
  wrap(async (req, res) => {
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const user = await User.findOne({ username });
    const ok = user && (await bcrypt.compare(password, user.passwordHash));
    if (!ok) return res.status(401).json({ error: 'Wrong username or password.' });
    if (user.banned) return res.status(403).json({ error: 'This account is suspended.' });
    User.updateOne({ _id: user._id }, { $set: { lastSeen: new Date() } }).catch(() => {});
    setCookie(res, signToken(user));
    res.json({ user: publicUser(user) });
  })
);

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// --- quizzes ---
app.get(
  '/api/quizzes',
  softAuth,
  wrap(async (req, res) => {
    const scope = String(req.query.scope || 'all');
    const filter = {};
    if (scope === 'official') filter.official = true;
    else if (scope === 'community') filter.official = false;
    else if (scope === 'mine') {
      if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
      filter.owner = req.user._id;
    }
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q) {
      const rx = new RegExp(util.escapeRegex(q), 'i');
      filter.$or = [{ title: rx }, { subtitle: rx }, { subject: rx }, { courseCode: rx }];
    }
    const quizzes = await Quiz.find(filter).select('-questions').sort({ createdAt: -1 }).limit(60);
    res.json({ quizzes: quizzes.map((x) => quizMeta(x, req.user)) });
  })
);

app.post(
  '/api/quizzes',
  auth,
  wrap(async (req, res) => {
    const parsed = util.parseQuizInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin) {
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const n = await Quiz.countDocuments({ owner: req.user._id, createdAt: { $gte: since } });
      if (n >= 20) return res.status(429).json({ error: 'You can create up to 20 quizzes per day.' });
    }
    const quiz = await util.createQuiz({
      data: parsed.data,
      owner: req.user._id,
      ownerName: req.user.displayName,
      official: isAdmin,
      source: 'web',
    });
    res.json({ quiz: quizMeta(quiz, req.user) });
  })
);

app.get(
  '/api/quizzes/:code',
  softAuth,
  wrap(async (req, res) => {
    const quiz = await Quiz.findOne({ code: req.params.code }).select('-questions');
    if (!quiz) return res.status(404).json({ error: 'Quiz not found. Check the link and try again.' });
    res.json({ quiz: quizMeta(quiz, req.user) });
  })
);

app.delete(
  '/api/quizzes/:code',
  auth,
  wrap(async (req, res) => {
    const quiz = await Quiz.findOne({ code: req.params.code }).select('-questions');
    if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
    const can = req.user.role === 'admin' || (quiz.owner && quiz.owner.equals(req.user._id));
    if (!can) return res.status(403).json({ error: 'You can only delete your own quizzes.' });
    await Attempt.deleteMany({ quiz: quiz._id });
    await Quiz.deleteOne({ _id: quiz._id });
    res.json({ ok: true });
  })
);

app.get(
  '/api/quizzes/:code/leaderboard',
  wrap(async (req, res) => {
    const quiz = await Quiz.findOne({ code: req.params.code }).select('_id');
    if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
    const rows = await Attempt.aggregate([
      { $match: { quiz: quiz._id, status: 'submitted' } },
      { $addFields: { timeMs: { $subtract: ['$submittedAt', '$startedAt'] } } },
      { $sort: { score: -1, timeMs: 1 } },
      {
        $group: {
          _id: '$user',
          username: { $first: '$username' },
          score: { $first: '$score' },
          total: { $first: '$total' },
          timeMs: { $first: '$timeMs' },
        },
      },
      { $sort: { score: -1, timeMs: 1 } },
      { $limit: 20 },
    ]);
    res.json({
      leaderboard: rows.map((r) => ({
        id: String(r._id),
        username: r.username,
        score: r.score,
        total: r.total,
        timeMs: r.timeMs,
      })),
    });
  })
);

// --- attempts ---
app.post(
  '/api/quizzes/:code/start',
  auth,
  wrap(async (req, res) => {
    const quiz = await Quiz.findOne({ code: req.params.code });
    if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });

    let attempt = await Attempt.findOne({ user: req.user._id, quiz: quiz._id, status: 'active' });
    if (attempt && attempt.endsAt.getTime() <= Date.now()) {
      await finalize(attempt, quiz, true);
      attempt = null;
    }
    if (!attempt) {
      const now = Date.now();
      try {
        attempt = await Attempt.create({
          quiz: quiz._id,
          user: req.user._id,
          username: req.user.displayName,
          answers: quiz.questions.map(() => -1),
          startedAt: new Date(now),
          endsAt: new Date(now + quiz.durationMinutes * 60000),
        });
        await Quiz.updateOne({ _id: quiz._id }, { $inc: { attempts: 1 } });
      } catch (e) {
        if (e.code !== 11000) throw e;
        attempt = await Attempt.findOne({ user: req.user._id, quiz: quiz._id, status: 'active' });
        if (!attempt) throw e;
      }
    }
    res.json({ attempt: activePayload(attempt, quiz) });
  })
);

async function loadOwnAttempt(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: 'Attempt not found.' });
    return null;
  }
  const attempt = await Attempt.findById(req.params.id);
  if (!attempt || !attempt.user.equals(req.user._id)) {
    res.status(404).json({ error: 'Attempt not found.' });
    return null;
  }
  const quiz = await Quiz.findById(attempt.quiz);
  if (!quiz) {
    res.status(404).json({ error: 'This quiz was deleted.' });
    return null;
  }
  return { attempt, quiz };
}

app.put(
  '/api/attempts/:id/answers',
  auth,
  wrap(async (req, res) => {
    const found = await loadOwnAttempt(req, res);
    if (!found) return;
    const { attempt, quiz } = found;
    if (attempt.status !== 'active' || Date.now() > attempt.endsAt.getTime() + GRACE_MS) {
      return res.status(409).json({ error: 'This attempt is already closed.' });
    }
    const answers = util.sanitizeAnswers(req.body && req.body.answers, quiz);
    await Attempt.updateOne({ _id: attempt._id, status: 'active' }, { $set: { answers } });
    res.json({ ok: true });
  })
);

app.post(
  '/api/attempts/:id/submit',
  auth,
  wrap(async (req, res) => {
    const found = await loadOwnAttempt(req, res);
    if (!found) return;
    const { attempt, quiz } = found;
    if (attempt.status === 'submitted') return res.json({ ok: true, id: String(attempt._id) });
    const end = attempt.endsAt.getTime();
    if (Date.now() <= end + GRACE_MS && req.body && Array.isArray(req.body.answers)) {
      attempt.answers = util.sanitizeAnswers(req.body.answers, quiz);
    }
    const auto = (req.body && req.body.auto === true) || Date.now() >= end;
    await finalize(attempt, quiz, auto);
    res.json({ ok: true, id: String(attempt._id) });
  })
);

app.get(
  '/api/attempts/:id',
  auth,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Result not found.' });
    }
    let attempt = await Attempt.findById(req.params.id);
    const isOwner = attempt && attempt.user.equals(req.user._id);
    if (!attempt || (!isOwner && req.user.role !== 'admin')) {
      return res.status(404).json({ error: 'Result not found.' });
    }
    const quiz = await Quiz.findById(attempt.quiz);
    if (!quiz) return res.status(404).json({ error: 'This quiz was deleted.' });
    if (attempt.status === 'active' && attempt.endsAt.getTime() <= Date.now()) {
      attempt = await finalize(attempt, quiz, true);
    }
    if (attempt.status === 'active') {
      if (!isOwner) return res.status(403).json({ error: 'This attempt is still in progress.' });
      return res.json({ status: 'active', attempt: activePayload(attempt, quiz) });
    }
    res.json({ status: 'submitted', result: resultPayload(attempt, quiz) });
  })
);

app.get(
  '/api/my/attempts',
  auth,
  wrap(async (req, res) => {
    const list = await Attempt.find({ user: req.user._id, status: 'submitted' })
      .sort({ submittedAt: -1 })
      .limit(50)
      .populate('quiz', 'title code courseCode');
    res.json({
      attempts: list
        .filter((a) => a.quiz)
        .map((a) => ({
          id: String(a._id),
          quizCode: a.quiz.code,
          title: a.quiz.title,
          courseCode: a.quiz.courseCode,
          score: a.score,
          total: a.total,
          percent: a.total ? Math.round((a.score / a.total) * 100) : 0,
          submittedAt: a.submittedAt.getTime(),
        })),
    });
  })
);

// --- admin ---
app.get(
  '/api/admin/stats',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    res.json({ stats: await util.getStats() });
  })
);

app.get(
  '/api/admin/users',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
    const filter = q ? { username: new RegExp(util.escapeRegex(q)) } : {};
    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).limit(100),
      User.countDocuments(filter),
    ]);
    const ids = users.map((u) => u._id);
    const [attAgg, quizAgg] = await Promise.all([
      Attempt.aggregate([
        { $match: { user: { $in: ids }, status: 'submitted', total: { $gt: 0 } } },
        {
          $group: {
            _id: '$user',
            n: { $sum: 1 },
            avg: { $avg: { $multiply: [{ $divide: ['$score', '$total'] }, 100] } },
          },
        },
      ]),
      Quiz.aggregate([
        { $match: { owner: { $in: ids } } },
        { $group: { _id: '$owner', n: { $sum: 1 } } },
      ]),
    ]);
    const attMap = new Map(attAgg.map((a) => [String(a._id), a]));
    const quizMap = new Map(quizAgg.map((a) => [String(a._id), a.n]));
    res.json({
      total,
      users: users.map((u) => {
        const a = attMap.get(String(u._id));
        return {
          username: u.displayName,
          handle: u.username,
          role: u.role,
          banned: u.banned,
          joinedAt: u.createdAt.getTime(),
          lastSeen: u.lastSeen ? u.lastSeen.getTime() : null,
          attempts: a ? a.n : 0,
          avgPercent: a ? Math.round(a.avg) : 0,
          quizzes: quizMap.get(String(u._id)) || 0,
        };
      }),
    });
  })
);

app.post(
  '/api/admin/users/:handle/ban',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    const target = await User.findOne({ username: String(req.params.handle).toLowerCase() });
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.role === 'admin') {
      return res.status(400).json({ error: 'Remove admin rights first (use /removeadmin in the Telegram bot).' });
    }
    target.banned = !!(req.body && req.body.banned);
    await target.save();
    res.json({ ok: true, banned: target.banned });
  })
);

// ---------- static site ----------
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '10m', index: false }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'That request was not valid JSON.' });
  }
  if (err && err.status && err.status < 500) {
    return res.status(err.status).json({ error: 'Bad request.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
});

// ---------- background jobs ----------
// Closes attempts whose timer ran out but whose browser never submitted (tab closed, phone died).
async function sweepExpired() {
  const stale = await Attempt.find({
    status: 'active',
    endsAt: { $lt: new Date(Date.now() - GRACE_MS) },
  }).limit(100);
  for (const a of stale) {
    const quiz = await Quiz.findById(a.quiz);
    if (!quiz) {
      await Attempt.deleteOne({ _id: a._id });
      continue;
    }
    await finalize(a, quiz, true);
  }
}

(async () => {
  await mongoose.connect(MONGODB_URI);
  console.log('MongoDB connected');
  await Promise.all([User.init(), Quiz.init(), Attempt.init()]);

  startBot(app);

  app.listen(PORT, () => console.log(`${SITE_NAME} running on port ${PORT}`));

  setInterval(() => sweepExpired().catch((e) => console.error('sweep error:', e.message)), 30000);

  // Keep-awake: Render's free plan sleeps after ~15 minutes without traffic.
  // Pinging our own public URL every 4 minutes counts as traffic.
  if (PUBLIC_URL) {
    setInterval(() => {
      fetch(PUBLIC_URL + '/health').catch(() => {});
    }, 4 * 60 * 1000);
    console.log('Keep-awake ping enabled for', PUBLIC_URL);
  }
})().catch((e) => {
  console.error('Startup failed:', e);
  process.exit(1);
});
