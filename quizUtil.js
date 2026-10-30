const crypto = require('crypto');

const LETTERS = 'ABCDEF';

const TEMPLATE = {
  title: 'Cyber Security Basics',
  subtitle: 'Week 3 test',
  subject: 'Introduction to Cyber Security',
  courseCode: 'CYB 101',
  durationMinutes: 10,
  questions: [
    {
      question: 'What does the CIA triad stand for in security?',
      options: [
        'Central Intelligence Agency',
        'Confidentiality, Integrity, Availability',
        'Control, Identify, Authorize',
        'None of the above',
      ],
      answer: 'B',
      explanation: 'The CIA triad is Confidentiality, Integrity and Availability.',
    },
    {
      question: 'Which of these is a strong password habit?',
      options: ['Reusing one password', 'Using a password manager', 'Sharing it with friends'],
      answer: 'B',
      explanation: '',
    },
  ],
};

function clean(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validates quiz input (from the website or the Telegram bot).
 * Returns { data } on success or { error } with a plain-language message.
 */
function parseQuizInput(input, defaults = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'The quiz must be a JSON object with a title, a duration and a list of questions.' };
  }

  const title = clean(input.title != null ? input.title : defaults.title, 120);
  const subtitle = clean(input.subtitle != null ? input.subtitle : defaults.subtitle, 160);
  const subject = clean(input.subject != null ? input.subject : defaults.subject, 80);
  const courseCode = clean(
    input.courseCode != null ? input.courseCode : input.course != null ? input.course : defaults.courseCode,
    30
  );
  const durRaw =
    input.durationMinutes != null
      ? input.durationMinutes
      : input.duration != null
      ? input.duration
      : defaults.durationMinutes;
  const durationMinutes = Math.round(Number(durRaw));

  if (!title) return { error: 'Add a title.' };
  if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 300) {
    return { error: 'Duration must be a number of minutes between 1 and 300.' };
  }
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    return { error: 'Add at least one question.' };
  }
  if (input.questions.length > 200) {
    return { error: 'A quiz can have at most 200 questions.' };
  }

  const questions = [];
  for (let i = 0; i < input.questions.length; i++) {
    const q = input.questions[i] || {};
    const n = i + 1;
    const text = clean(q.question != null ? q.question : q.text, 1000);
    if (!text) return { error: `Question ${n} has no text.` };
    if (!Array.isArray(q.options)) return { error: `Question ${n} needs a list of options.` };
    const options = q.options.map((o) => clean(o, 300));
    if (options.length < 2 || options.length > 6) {
      return { error: `Question ${n} needs between 2 and 6 options.` };
    }
    if (options.some((o) => !o)) return { error: `Question ${n} has an empty option.` };

    let idx = -1;
    const a = q.answer != null ? q.answer : q.correct;
    if (typeof a === 'string') {
      const t = a.trim();
      if (/^[A-Fa-f]$/.test(t)) idx = LETTERS.indexOf(t.toUpperCase());
      else idx = options.findIndex((o) => o.toLowerCase() === t.toLowerCase());
    }
    if (idx < 0 || idx >= options.length) {
      return {
        error: `Question ${n}: "answer" must be a letter from A to ${LETTERS[options.length - 1]} that matches one of the options.`,
      };
    }
    questions.push({ text, options, correct: idx, explanation: clean(q.explanation, 1000) });
  }

  return { data: { title, subtitle, subject, courseCode, durationMinutes, questions } };
}

function newCode() {
  return crypto.randomBytes(4).toString('hex');
}

async function createQuiz({ data, owner = null, ownerName = 'Admin', official = false, source = 'web' }) {
  const { Quiz } = require('./models');
  for (let i = 0; i < 5; i++) {
    try {
      return await Quiz.create({
        ...data,
        code: newCode(),
        questionCount: data.questions.length,
        owner,
        ownerName,
        official,
        source,
      });
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
  throw new Error('Could not generate a quiz code. Try again.');
}

function gradeAnswers(quiz, answers) {
  let score = 0;
  quiz.questions.forEach((q, i) => {
    if (answers[i] === q.correct) score += 1;
  });
  return score;
}

function sanitizeAnswers(raw, quiz) {
  const out = quiz.questions.map(() => -1);
  if (Array.isArray(raw)) {
    quiz.questions.forEach((q, i) => {
      const v = raw[i];
      if (Number.isInteger(v) && v >= 0 && v < q.options.length) out[i] = v;
    });
  }
  return out;
}

// Start of "today" in West Africa (UTC+1, no daylight saving)
function startOfTodayLagos() {
  const off = 3600000;
  return new Date(Math.floor((Date.now() + off) / 86400000) * 86400000 - off);
}

async function getStats() {
  const { User, Quiz, Attempt } = require('./models');
  const sod = startOfTodayLagos();
  const week = new Date(Date.now() - 7 * 86400000);

  const [
    usersTotal,
    admins,
    banned,
    usersToday,
    usersWeek,
    activeToday,
    quizzesTotal,
    quizzesOfficial,
    quizzesToday,
    attemptsTotal,
    attemptsSubmitted,
    attemptsToday,
    attemptsActive,
    avgAgg,
    top,
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ role: 'admin' }),
    User.countDocuments({ banned: true }),
    User.countDocuments({ createdAt: { $gte: sod } }),
    User.countDocuments({ createdAt: { $gte: week } }),
    User.countDocuments({ lastSeen: { $gte: sod } }),
    Quiz.countDocuments({}),
    Quiz.countDocuments({ official: true }),
    Quiz.countDocuments({ createdAt: { $gte: sod } }),
    Attempt.countDocuments({}),
    Attempt.countDocuments({ status: 'submitted' }),
    Attempt.countDocuments({ createdAt: { $gte: sod } }),
    Attempt.countDocuments({ status: 'active' }),
    Attempt.aggregate([
      { $match: { status: 'submitted', total: { $gt: 0 } } },
      { $group: { _id: null, avg: { $avg: { $multiply: [{ $divide: ['$score', '$total'] }, 100] } } } },
    ]),
    Quiz.find({}).select('title code attempts').sort({ attempts: -1 }).limit(5),
  ]);

  return {
    users: { total: usersTotal, admins, banned, today: usersToday, week: usersWeek, activeToday },
    quizzes: {
      total: quizzesTotal,
      official: quizzesOfficial,
      community: quizzesTotal - quizzesOfficial,
      today: quizzesToday,
    },
    attempts: {
      total: attemptsTotal,
      submitted: attemptsSubmitted,
      today: attemptsToday,
      active: attemptsActive,
      avgPercent: avgAgg.length ? Math.round(avgAgg[0].avg) : 0,
    },
    top: top.map((t) => ({ title: t.title, code: t.code, attempts: t.attempts })),
  };
}

module.exports = {
  TEMPLATE,
  LETTERS,
  clean,
  escapeRegex,
  parseQuizInput,
  createQuiz,
  gradeAnswers,
  sanitizeAnswers,
  getStats,
};
